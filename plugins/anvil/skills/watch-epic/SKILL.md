---
name: watch-epic
description: "Arm or disarm a recurring background watch on an anvil epic: a scheduled tick re-invokes /anvil:run-epic headlessly when a stalled epic becomes unblocked (its children go ready in beads again), and the watch retires itself once the epic PR is open, the cut is falsified, or the re-invocation cap is hit. Use after /anvil:run-epic stopped with no-ready-children or wave-merged-zero-slices, when the operator asks to watch or auto-resume an epic, or when they want to stop watching one."
---

# /anvil:watch-epic — a scheduled tick that resumes a stalled epic

`/anvil:run-epic` is a job that stops fail-closed. Most of its stops are
*waiting-on-operator*: `no-ready-children` (a slice stalled as a draft PR, or a
stub is held), `wave-merged-zero-slices`, `max-waves-reached`. The operator then
adjudicates in beads — and the epic sits there until somebody re-runs it.

This skill arms **one recurring watch per epic**, named `anvil-epic-<epic-id>`
on every platform, that does the re-running: every 15 minutes a tick reads
`~/.anvil/runs/epic-events.log` from a persisted cursor, and when the epic is
both *stalled* and *unblocked again* (a child reappears in `bd ready`) it
re-invokes run-epic **headlessly**. It retires itself when the epic truly ends.

The operator arms it explicitly. That invocation **is** the authority to re-run.
The watch still never merges anything: it only re-enters the same workflow the
operator would have re-entered by hand, which ends at ONE draft PR.

## While a watch is armed

**Do not hand-run `/anvil:run-epic` for a watched epic.** The tick's lock
serializes *watch-invoked* runs only — it is a lock file, and it cannot see an
interactive Claude Code session. A tick that fires while you are running the
epic yourself will happily start a second run over the same integration branch.

The safe rhythm is: `/anvil:watch-epic <epic-id> off` → run it by hand →
`/anvil:watch-epic <epic-id>` to re-arm. (Re-arming preserves the counters
unless the watch had retired.)

The tick *does* infer a live run from the event stream — a trailing `wave-start`
with no stop after it marks `runInFlight` and suppresses invocation — but that
inference lags by up to one interval. It is a safety net, not permission.

## Invocation forms

```
/anvil:watch-epic <epic-id> [--repo <path>] [--max-waves <1-10>] [--base-branch <name>] [--implement-model <name>]
/anvil:watch-epic <epic-id> off
```

- `<epic-id>` **must** match `^[A-Za-z0-9][A-Za-z0-9_-]*$`. Refuse anything else
  **before writing any state** — the id is interpolated into file paths, a
  launchd label, systemd unit names and a crontab marker; that regex is what
  makes every one of those interpolations safe.
- Reject NUL, CR or LF in every persisted value, and quote/escape each one in
  the grammar it lands in (JSON, plist XML, unit file, crontab).
- `--repo` is canonicalized to an absolute git top level.
- `--max-waves` defaults to 3, clamp 1–10.
- `--base-branch` / `--implement-model` are the only optional keys of the
  invocation contract; pass them through verbatim, omit them otherwise.

## Operator-scoped state (all of it, and nothing else)

| path | what |
| --- | --- |
| `~/.anvil/runs/epic-<epicId>.json` | invocation contract (frozen seam) |
| `~/.anvil/runs/epic-<epicId>.watch.json` | watch state (cursor, counters) |
| `~/.anvil/runs/epic-<epicId>.tick.sh` | the tick script, written at arm time |
| `~/.anvil/runs/epic-<epicId>.lock` | mutual-exclusion lock **directory** |
| `~/.anvil/runs/epic-<epicId>.watch.log` | the tick's own plain-text log |
| `~/.anvil/runs/epic-events.log` | the shared event stream (read, appended) |

Nothing lands in the target repo. Never create the lock directory at arm time:
it must be **absent while idle**, created only by a tick's successful atomic
`mkdir`, and removed only by that lock owner's cleanup.

Both JSON files — written by the arm step and by the tick — use exactly one
layout: one key per line, two-space indent, **every** value a double-quoted
string (numbers and booleans included), no nesting, keys in the order below,
closing `}` on its own line. That is what makes the tick's one-line `sed` reader
correct. String values are JSON-escaped on write (backslash and double quote —
the only two escapes this layout can ever produce) and unescaped on read, so
`lastStoppedDetail` and paths containing quotes or backslashes round-trip
exactly. The tick refuses (`reinvoke-aborted`) any file that deviates from the
frozen layout: wrong key order, duplicate, missing or unknown keys, or a value
that is not one double-quoted string.

`~/.anvil/runs/epic-<epicId>.json` — the six required keys are frozen, and
`baseBranch` / `implementModel` are the only optional ones (present **iff** the
operator armed with them). No other field is ever added; the run-epic script
path is **not** a field — the tick derives it as
`dirname(atomScriptPath)/run-epic.js`.

```json
{
  "epicId": "beads-1jo",
  "repoRoot": "/Users/you/repositories/smithy",
  "atomScriptPath": "/Users/you/.claude/plugins/.../anvil/workflows/execute-review-fix.js",
  "pciScriptPath": "/Users/you/.claude/plugins/.../anvil/workflows/plan-critique-improve.js",
  "maxWaves": "3",
  "beadsDir": "/Users/you/.anvil/beads"
}
```

`~/.anvil/runs/epic-<epicId>.watch.json`:

```json
{
  "offsetBytes": "10432",
  "reinvokeCount": "0",
  "retired": "false",
  "lastStoppedDetail": "no-ready-children; 2 stalled slices",
  "armedAt": "1786000000",
  "consecutiveAbortCount": "0",
  "runInFlight": "false"
}
```

## Arming

### 1. Resolve, verify, and check the authority the headless run will inherit

Resolve the workflow dir exactly as `/anvil:run-epic` does (**`${CLAUDE_PLUGIN_ROOT}`
is NOT expanded in skill text**):

```sh
WFDIR="${ANVIL_PLUGIN_ROOT:+$ANVIL_PLUGIN_ROOT/workflows}"
[ -d "$WFDIR" ] || WFDIR="$(find "$HOME/.claude/plugins" -type d -path '*anvil*/workflows' 2>/dev/null | head -1)"
ls "$WFDIR/run-epic.js" "$WFDIR/execute-review-fix.js" "$WFDIR/plan-critique-improve.js"
```

Then:

- The plan map `~/.anvil/specs/<epicId>.md` must exist. run-epic's setup step
  resolves the repo **from the plan map**, not from this JSON.
- Resolve `repoRoot` as `git -C <candidate> rev-parse --show-toplevel`
  (candidate = the cwd's repo, or the path `--repo` names) and confirm it is the
  same path the plan map names. On a mismatch — or a missing plan map — refuse
  to arm and print **both** paths.
- `beadsDir` = `${BEADS_DIR:-$HOME/.anvil/beads}`; `maxWaves` = operator-passed,
  default 3.
- The epic must exist: `BEADS_DIR="$beadsDir" bd show <epicId>`.
- Run the arm preflight below. It checks the four binaries **under the tick's
  pinned PATH** (not this shell's — no env survives into a scheduled shell) and
  checks the authority the headless run inherits: workflow subagents always run
  acceptEdits plus the operator's *configured* tool allowlist, and a `-p`
  session follows the configured rules with nobody to prompt. So
  `~/.claude/settings.json` `permissions.allow` must already contain
  `Bash(git *)`, `Bash(gh pr *)`, `Bash(gh label *)` and `Bash(bd *)` (a broader
  `Bash(gh *)` satisfies both gh checks; `Bash(br *)` satisfies the beads check
  where `br` is the beads binary). **Refuse to arm** naming every missing grant
  and point the operator at the `update-config` skill — never edit their
  settings yourself.

The tick calls `bd` by that name. If `br` is your beads binary, expose it as
`bd` on `$HOME/.local/bin` before arming; the preflight will tell you.

<!-- ANVIL-ARM-PREFLIGHT-BEGIN -->
```sh
# Arm-time preflight. Run inline in the interactive session. Prints one line.
TICK_PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
missing_bins=""
for b in claude bd git gh; do
  env -i HOME="$HOME" PATH="$TICK_PATH" sh -c "command -v $b" >/dev/null 2>&1 || missing_bins="$missing_bins $b"
done
SETTINGS="$HOME/.claude/settings.json"
missing_grants=""
# List ONLY the strings inside permissions.allow — the same spelling anywhere
# else in settings.json (permissions.deny above all) must NOT count as a grant.
allow_grants() {
  awk '
    /"permissions"[[:space:]]*:/ { inperm = 1 }
    inperm && /"allow"[[:space:]]*:/ { inallow = 1 }
    inallow {
      line = $0
      sub(/^.*"allow"[[:space:]]*:/, "", line)
      done = index(line, "]")
      if (done) line = substr(line, 1, done - 1)
      while (match(line, /"([^"\\]|\\.)*"/)) {
        print substr(line, RSTART + 1, RLENGTH - 2)
        line = substr(line, RSTART + RLENGTH)
      }
      if (done) { inallow = 0; inperm = 0 }
    }
    inperm && !inallow && /}/ { inperm = 0 }
  ' "$SETTINGS" 2>/dev/null
}
have_grant() { allow_grants | grep -qxF "$1"; }
if [ -f "$SETTINGS" ]; then
  have_grant 'Bash(git *)' || missing_grants="$missing_grants Bash(git_*)"
  have_grant 'Bash(gh *)' || have_grant 'Bash(gh pr *)' || missing_grants="$missing_grants Bash(gh_pr_*)"
  have_grant 'Bash(gh *)' || have_grant 'Bash(gh label *)' || missing_grants="$missing_grants Bash(gh_label_*)"
  have_grant 'Bash(bd *)' || have_grant 'Bash(br *)' || missing_grants="$missing_grants Bash(bd_*)"
else
  missing_grants=" (no $SETTINGS)"
fi
if [ -n "$missing_bins" ] || [ -n "$missing_grants" ]; then
  printf 'ARM-PREFLIGHT: REFUSE; missing binaries on the tick PATH:%s; missing permissions.allow grants:%s\n' "${missing_bins:- none}" "${missing_grants:- none}"
else
  printf 'ARM-PREFLIGHT: OK\n'
fi
```
<!-- ANVIL-ARM-PREFLIGHT-END -->

Report each missing grant back to the operator with its real spelling —
`Bash(git *)`, `Bash(gh pr *)`, `Bash(gh label *)`, `Bash(bd *)`; the underscores
above only keep the marker line free of shell-hostile spacing.

### 2. Determine the timer mechanism FIRST — before writing any state file

- `uname` = `Darwin` → launchd LaunchAgent.
- `uname` = `Linux` and `systemctl --user` works → systemd user timer.
- `uname` = `Linux` without systemd but with `crontab` → cron.
- Anything else → **write nothing** and report exactly:
  `watch-epic supports macOS (launchd) and Linux (systemd user timer or cron) only — nothing was armed.`

Never cron on macOS: its administration hangs on an interactive security prompt
(proved by the P1 probe).

### 3. Check the lock

Re-arm and `off` both **first** check the tick lock — a tick, or the run it
invoked, may be in flight:

```sh
LOCK="$HOME/.anvil/runs/epic-<epicId>.lock"
if [ -d "$LOCK" ]; then
  lockpid=$(head -1 "$LOCK/pid" 2>/dev/null | tr -dc '0-9')
  if [ -n "$lockpid" ] && kill -0 "$lockpid" 2>/dev/null; then
    echo "REFUSE: tick or invoked run in flight (pid $lockpid); retry after it releases"
  elif [ -n "$lockpid" ]; then
    rm -rf "$LOCK"   # stale: recorded pid is dead
  else
    echo "REFUSE: lock present, pid unreadable; retry"
  fi
fi
```

Refuse to mutate **any** state or timer while the lock is live, and tell the
operator why. A stale lock (dead recorded PID) is cleared per the tick's own
rule, then arming proceeds. Never remove a lock whose pid cannot be read.

### 4. Scan the existing log and evaluate every refusal — before any write

Scan the **whole existing log**, read-only, so that arming *after* a stall
still sees the stall — while the cursor starts at end-of-file so the first tick
consumes zero bytes. This step creates and writes **nothing** (not even a
`touch`): the arm-time refusals below must leave no trace, and no state file is
written until step 5 has seen every check pass:

<!-- ANVIL-ARM-SEED-BEGIN -->
```sh
# Arm-time seed scan. READ-ONLY — it writes nothing and creates nothing, so a
# refusal leaves no trace. Run inline with EPIC_ID already set. Prints SEED_*.
: "${EPIC_ID:?set EPIC_ID first}"
RUNS="$HOME/.anvil/runs"
EVENTS="$RUNS/epic-events.log"
SEED_OFFSET=0
SEED_LASTSTOP=""
SEED_INFLIGHT=false
SEED_PR_OPEN=no
lastrunev=""
if [ -f "$EVENTS" ]; then
SEED_OFFSET=$(wc -c < "$EVENTS" | tr -d ' ')
while IFS= read -r line; do
  case "$line" in anvil-epic\|*) ;; *) continue ;; esac
  case "$line" in *\|*\|*\|*\|*\|*) ;; *) continue ;; esac
  rest=${line#*|}; rest=${rest#*|}
  eid=${rest%%|*}; rest=${rest#*|}
  ev=${rest%%|*}; rest=${rest#*|}
  detail=${rest#*|}
  [ "$eid" = "$EPIC_ID" ] || continue
  case "$detail" in reinvoke-aborted*|reinvoke-cap-reached*|watch-expired*) continue ;; esac
  lastrunev="$ev"
  if [ "$ev" = "epic-pr-open" ]; then
    case "$detail" in *https://*) SEED_PR_OPEN=yes ;; esac
  fi
  if [ "$ev" = "stopped" ]; then
    case "$detail" in
      setup-failed*|frontier-agent-failed*|no-ready-children*|wave-merged-zero-slices*|cut-falsified*|max-waves-reached*|epic-complete*)
        SEED_LASTSTOP="$detail" ;;
    esac
  fi
done < "$EVENTS"
fi
[ "$lastrunev" = "wave-start" ] && SEED_INFLIGHT=true
case "$SEED_LASTSTOP" in cut-falsified*) SEED_CUT_FALSIFIED=yes ;; *) SEED_CUT_FALSIFIED=no ;; esac
printf 'SEED_OFFSET=%s\nSEED_INFLIGHT=%s\nSEED_PR_OPEN=%s\nSEED_CUT_FALSIFIED=%s\nSEED_ARMED_AT=%s\nSEED_LASTSTOP=%s\n' \
  "$SEED_OFFSET" "$SEED_INFLIGHT" "$SEED_PR_OPEN" "$SEED_CUT_FALSIFIED" "$(date +%s)" "$SEED_LASTSTOP"
```
<!-- ANVIL-ARM-SEED-END -->

**Arm-time refusals** (tell the operator why; nothing has been written, and
nothing may be):

- `SEED_PR_OPEN=yes` — a valid `epic-pr-open` line for this epic carrying a PR
  URL. The epic is done; there is nothing to watch.
- `SEED_CUT_FALSIFIED=yes` — the **last** `stopped` line for this epic (of the
  seven run-epic tokens; the watch's own stops never supersede) begins
  `cut-falsified`. Last-line semantics on purpose: the log is never rotated, and
  an old falsification superseded by a recut and later activity must not block
  arming forever.

### 5. Only now write the state files

Every refusal has passed; this is the first write of the arm. `mkdir -p`
`~/.anvil/runs`, `touch` the event log and `epic-<epicId>.watch.log`, then
write `~/.anvil/runs/epic-<epicId>.json` in the layout above, with absolute
paths: `atomScriptPath` = `$WFDIR/execute-review-fix.js`, `pciScriptPath` =
`$WFDIR/plan-critique-improve.js`.

The watch state is written by exactly one of three branches — never
unconditionally:

- **New watch** (no `epic-<epicId>.watch.json`): write it fresh —
  `offsetBytes` = `SEED_OFFSET`, `reinvokeCount` 0, `consecutiveAbortCount` 0,
  `retired` false, `armedAt` = `SEED_ARMED_AT`, `runInFlight` =
  `SEED_INFLIGHT`, `lastStoppedDetail` = `SEED_LASTSTOP`.
- **Active watch** (existing state with `retired` `false`): leave the
  watch-state file **untouched** — a re-arm preserves the counters and the
  cursor (step 8); reseeding `reinvokeCount` or `offsetBytes` here would bypass
  the cap and replay the log.
- **Retired watch** (existing state with `retired` `true`): the explicit
  re-arm is the sanctioned recovery — write it fresh exactly as for a new
  watch, and log the reset in the watch log.

### 6. Write the tick script

Write `~/.anvil/runs/epic-<epicId>.tick.sh` **with the Write tool** — never a
shell heredoc or `echo`. A heredoc would expand `$HOME`, `$$` and `$(…)` at arm
time and freeze them to the arming shell (`$$` would become the arming
session's PID, so the lock's liveness check would always report "live").
Every `$HOME`, `$$`, `$(…)` and backslash in the template must land in the file
byte-for-byte.

Substitute **exactly one placeholder**: the `<epicId>` on the `EPIC_ID=` line,
i.e. the single substitution `EPIC_ID='<epicId>'` → `EPIC_ID='beads-1jo'`, which
is what `sed "s/^EPIC_ID='<epicId>'\$/EPIC_ID='<the id>'/"` would do. The other
`<epicId>` in the template sits inside the pinned re-invocation prompt, in the
frozen six-field format line `anvil-epic|<utc-iso8601>|<epicId>|<event>|<sliceId>|<detail>`
— that is format documentation for the headless session and stays byte-for-byte.
A blind global replace is a bug.

Then `sh -n` it — **abort the arm and write no timer if that fails** — and
`chmod 700` it.

The template — extract it with the anchored marker range (the anchors are what
keep this very sentence from matching):

```sh
sed -n '/^<!-- ANVIL-TICK-TEMPLATE-BEGIN -->$/,/^<!-- ANVIL-TICK-TEMPLATE-END -->$/p' SKILL.md \
  | sed '1,2d' | sed '$d' | sed '$d'
```

<!-- ANVIL-TICK-TEMPLATE-BEGIN -->
```sh
#!/bin/sh
# anvil watch-epic tick. Generated by /anvil:watch-epic at arm time — do not
# hand-edit; re-arm to refresh it. One arm-time substitution: the epic id below.
EPIC_ID='<epicId>'

# P1 condition: no env survives into a scheduled shell, and claude lives in
# $HOME/.local/bin. Pin the PATH, then prove the binaries resolve on it.
PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export PATH

RUNS="$HOME/.anvil/runs"
EVENTS="$RUNS/epic-events.log"
CONTRACT="$RUNS/epic-$EPIC_ID.json"
STATE="$RUNS/epic-$EPIC_ID.watch.json"
LOCK="$RUNS/epic-$EPIC_ID.lock"
WATCHLOG="$RUNS/epic-$EPIC_ID.watch.log"
TIMER="anvil-epic-$EPIC_ID"
WIN="$RUNS/epic-$EPIC_ID.window.tmp"
CLAUDE_BIN="${ANVIL_WATCH_CLAUDE_BIN:-claude}"

mkdir -p "$RUNS" 2>/dev/null

log() {
  printf '%s tick %s\n' "$(date -u +%FT%TZ)" "$*" >> "$WATCHLOG" 2>/dev/null
}

# --- events: the watch owns exactly three stop tokens, all best-effort -------
emit_abort() {
  reason=$(printf '%s' "$1" | tr '|' '/' | tr '\r\n' '  ' | cut -c1-200) ; mkdir -p "$HOME/.anvil/runs" && printf 'anvil-epic|%s|%s|stopped||reinvoke-aborted; %s\n' "$(date -u +%FT%TZ)" "$EPIC_ID" "$reason" >> "$HOME/.anvil/runs/epic-events.log" || log "event append failed: reinvoke-aborted"
  log "reinvoke-aborted: $reason"
}

emit_cap() {
  mkdir -p "$HOME/.anvil/runs" && printf 'anvil-epic|%s|%s|stopped||reinvoke-cap-reached; after 6 re-invocations\n' "$(date -u +%FT%TZ)" "$EPIC_ID" >> "$HOME/.anvil/runs/epic-events.log" || log "event append failed: reinvoke-cap-reached"
  log "reinvoke-cap-reached"
}

emit_expired() {
  reason=$(printf '%s' "$1" | tr '|' '/' | tr '\r\n' '  ' | cut -c1-200) ; mkdir -p "$HOME/.anvil/runs" && printf 'anvil-epic|%s|%s|stopped||watch-expired; %s\n' "$(date -u +%FT%TZ)" "$EPIC_ID" "$reason" >> "$HOME/.anvil/runs/epic-events.log" || log "event append failed: watch-expired"
  log "watch-expired: $reason"
}

# --- tiny JSON helpers: one key per line, every value a quoted string --------
# jesc JSON-escapes the only two structural characters this layout can carry
# (backslash first, then double quote); jget undoes exactly those escapes on
# read, so values round-trip byte-for-byte.
jget() {
  sed -n 's/^  "'"$2"'": "\(.*\)"[,]\{0,1\}$/\1/p' "$1" | head -1 | awk '{
    out = ""; i = 1
    while (i <= length($0)) {
      c = substr($0, i, 1)
      if (c == "\\" && i < length($0)) { out = out substr($0, i + 1, 1); i = i + 2 }
      else { out = out c; i = i + 1 }
    }
    print out
  }'
}
jhas() { grep -q '^  "'"$2"'": "' "$1" 2>/dev/null; }
jesc() { printf '%s\n' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
is_uint() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
is_bool() { case "$1" in true|false) return 0 ;; *) return 1 ;; esac; }

# Frozen-layout check: "{" first, "}" alone last, exactly the given keys in the
# given order (a leading ? marks an optional key), one key per line with a
# two-space indent and a double-quoted value, a comma on every key line but the
# last, and nothing else. Rejects duplicate, unknown, reordered and missing
# keys before any value is trusted.
jlayout() {
  jl_file=$1; shift
  awk -v keys="$*" '
    BEGIN { nk = split(keys, K, " "); ki = 0 }
    bad { next }
    NR == 1 { if ($0 != "{") bad = 1; next }
    $0 == "}" && !sawend { sawend = 1; if (nseen > 0 && prevcomma) bad = 1; next }
    sawend { bad = 1; next }
    {
      if (nseen > 0 && !prevcomma) { bad = 1; next }
      if ($0 !~ /^  "[A-Za-z]+": ".*"[,]?$/) { bad = 1; next }
      key = $0
      sub(/^  "/, "", key); sub(/": .*$/, "", key)
      ok = 0
      while (ki < nk) {
        ki++
        k = K[ki]
        opt = (substr(k, 1, 1) == "?")
        if (opt) k = substr(k, 2)
        if (k == key) { ok = 1; break }
        if (!opt) break
      }
      if (!ok) { bad = 1; next }
      prevcomma = ($0 ~ /,$/)
      nseen++
    }
    END {
      if (bad || !sawend || nseen == 0) exit 1
      while (ki < nk) { ki++; if (substr(K[ki], 1, 1) != "?") exit 1 }
      exit 0
    }
  ' "$jl_file" 2>/dev/null
}

write_state() {
  tmp="$STATE.tmp"
  {
    printf '{\n'
    printf '  "offsetBytes": "%s",\n' "$W_OFFSET"
    printf '  "reinvokeCount": "%s",\n' "$W_REINVOKE"
    printf '  "retired": "%s",\n' "$W_RETIRED"
    printf '  "lastStoppedDetail": "%s",\n' "$(jesc "$W_LASTSTOP")"
    printf '  "armedAt": "%s",\n' "$W_ARMEDAT"
    printf '  "consecutiveAbortCount": "%s",\n' "$W_ABORTS"
    printf '  "runInFlight": "%s"\n' "$W_INFLIGHT"
    printf '}\n'
  } > "$tmp" && mv "$tmp" "$STATE"
}

# Timer removal. Disarm the schedule while its definition is still loaded
# wherever the platform allows it, delete definitions around that, and LOG
# every scheduler failure — a swallowed error must not let retired state
# diverge silently from an installed timer. No daemon-reload here: reloading
# before disable would make the unit not-found and the disable a silent no-op
# (re-arm owns daemon-reload). The command that can kill this very process
# (launchctl bootout of our own gui job) is ALWAYS last; stopping a systemd
# timer unit does not kill the running oneshot service, so systemd may
# disable first.
remove_timer() {
  if [ "$(uname 2>/dev/null)" = "Darwin" ]; then
    rm -f "$HOME/Library/LaunchAgents/$TIMER.plist" 2>/dev/null || log "timer removal: could not delete $TIMER.plist"
    log "timer removal: plist deleted, booting out $TIMER (last action)"
    launchctl bootout "gui/$(id -u)/$TIMER" >/dev/null 2>&1 || launchctl unload "$HOME/Library/LaunchAgents/$TIMER.plist" >/dev/null 2>&1 || log "timer removal: bootout failed and the unload fallback could not use the deleted plist; the loaded job may persist until logout (state is retired, so its ticks no-op)"
    return 0
  fi
  if [ -f "$HOME/.config/systemd/user/$TIMER.timer" ]; then
    systemctl --user disable --now "$TIMER.timer" >/dev/null 2>&1 || log "timer removal: disable --now $TIMER.timer failed; the timer may still be listed"
    rm -f "$HOME/.config/systemd/user/$TIMER.timer" "$HOME/.config/systemd/user/$TIMER.service" 2>/dev/null || log "timer removal: could not delete $TIMER unit files"
    log "timer removal: $TIMER.timer disabled while still loaded, unit files deleted; no daemon-reload — re-arm owns that"
    return 0
  fi
  if ( crontab -l 2>/dev/null | grep -v "# $TIMER\$" ) | crontab - 2>/dev/null; then
    log "timer removal: crontab line for $TIMER deleted"
  else
    log "timer removal: crontab update failed; the cron line may persist"
  fi
}

retire() {
  W_RETIRED=true
  if ! write_state; then
    emit_abort "failed to persist retirement ($1); timer left in place"
    exit 0
  fi
  log "retired: $1"
  remove_timer
}

# --- preflight: a missing bd must never look like "no ready children" -------
for b in "$CLAUDE_BIN" bd git gh; do
  command -v "$b" >/dev/null 2>&1 || { emit_abort "required binary $b not on the tick PATH"; exit 0; }
done

# --- 1. retired? ------------------------------------------------------------
if [ -f "$STATE" ] && [ "$(jget "$STATE" retired)" = "true" ]; then
  exit 0
fi

# --- 2. lock (mkdir is the portable atomic primitive) -----------------------
release_lock() { rm -rf "$WIN" "$WIN.lines" "$LOCK" 2>/dev/null; }
if mkdir "$LOCK" 2>/dev/null; then
  printf '%s\n' "$$" > "$LOCK/pid"
  trap 'release_lock' EXIT
  trap 'release_lock; exit 1' INT TERM HUP
else
  lockpid=""
  tries=0
  while [ "$tries" -lt 5 ]; do
    lockpid=$(head -1 "$LOCK/pid" 2>/dev/null | tr -dc '0-9')
    [ -n "$lockpid" ] && break
    tries=$((tries + 1))
    [ "$tries" -lt 5 ] && sleep 1
  done
  if [ -z "$lockpid" ]; then
    log "lock pid unavailable"
    exit 0
  fi
  if kill -0 "$lockpid" 2>/dev/null; then
    log "lock held by live pid $lockpid; no-op"
    exit 0
  fi
  log "stale lock (recorded pid $lockpid is not alive); clearing and re-acquiring"
  rm -rf "$LOCK" 2>/dev/null
  if mkdir "$LOCK" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK/pid"
    trap 'release_lock' EXIT
    trap 'release_lock; exit 1' INT TERM HUP
  else
    log "could not re-acquire lock after clearing a stale one; no-op"
    exit 0
  fi
fi

# --- 3. state and contract validation --------------------------------------
W_OFFSET=""; W_REINVOKE=""; W_RETIRED=""; W_LASTSTOP=""
W_ARMEDAT=""; W_ABORTS=""; W_INFLIGHT=""
state_bad=""
if [ ! -f "$STATE" ]; then
  state_bad="watch state $STATE is missing"
elif ! jlayout "$STATE" offsetBytes reinvokeCount retired lastStoppedDetail armedAt consecutiveAbortCount runInFlight; then
  state_bad="watch state does not match the frozen layout (key order, uniqueness, quoting)"
else
  W_OFFSET=$(jget "$STATE" offsetBytes)
  W_REINVOKE=$(jget "$STATE" reinvokeCount)
  W_RETIRED=$(jget "$STATE" retired)
  W_LASTSTOP=$(jget "$STATE" lastStoppedDetail)
  W_ARMEDAT=$(jget "$STATE" armedAt)
  W_ABORTS=$(jget "$STATE" consecutiveAbortCount)
  W_INFLIGHT=$(jget "$STATE" runInFlight)
  if ! is_uint "$W_OFFSET"; then state_bad="watch state offsetBytes is not a non-negative integer"
  elif ! is_uint "$W_REINVOKE"; then state_bad="watch state reinvokeCount is not a non-negative integer"
  elif ! is_uint "$W_ABORTS"; then state_bad="watch state consecutiveAbortCount is not a non-negative integer"
  elif ! is_uint "$W_ARMEDAT" || [ "$W_ARMEDAT" -le 0 ]; then state_bad="watch state armedAt is not a positive integer"
  elif ! is_bool "$W_RETIRED"; then state_bad="watch state retired is not a boolean"
  elif ! is_bool "$W_INFLIGHT"; then state_bad="watch state runInFlight is not a boolean"
  fi
fi
if [ -n "$state_bad" ]; then
  emit_abort "$state_bad"
  exit 0
fi

# absolute expiry: no timer is immortal
NOW=$(date +%s)
if [ $((NOW - W_ARMEDAT)) -gt 604800 ]; then
  W_RETIRED=true
  if ! write_state; then
    emit_abort "failed to persist the 7-day expiry retirement; timer left in place"
    exit 0
  fi
  emit_expired "7-day watch expiry"
  log "retired: 7-day watch expiry"
  remove_timer
  exit 0
fi

contract_bad=""
if [ ! -f "$CONTRACT" ]; then
  contract_bad="invocation contract $CONTRACT is missing"
elif ! jlayout "$CONTRACT" epicId repoRoot atomScriptPath pciScriptPath maxWaves beadsDir "?baseBranch" "?implementModel"; then
  contract_bad="invocation contract does not match the frozen layout (key order, uniqueness, quoting)"
else
  C_EPIC=$(jget "$CONTRACT" epicId)
  C_REPO=$(jget "$CONTRACT" repoRoot)
  C_ATOM=$(jget "$CONTRACT" atomScriptPath)
  C_PCI=$(jget "$CONTRACT" pciScriptPath)
  C_MAXW=$(jget "$CONTRACT" maxWaves)
  C_BEADS=$(jget "$CONTRACT" beadsDir)
  C_BASE=$(jget "$CONTRACT" baseBranch)
  C_MODEL=$(jget "$CONTRACT" implementModel)
  C_RUNEPIC="$(dirname "$C_ATOM")/run-epic.js"
  if [ "$C_EPIC" != "$EPIC_ID" ]; then contract_bad="contract epicId $C_EPIC is not this watch's epic $EPIC_ID"
  elif ! is_uint "$C_MAXW" || [ "$C_MAXW" -lt 1 ] || [ "$C_MAXW" -gt 10 ]; then contract_bad="contract maxWaves is not an integer 1-10"
  elif [ ! -d "$C_REPO" ]; then contract_bad="contract repoRoot $C_REPO is not a directory"
  elif [ ! -d "$C_BEADS" ]; then contract_bad="contract beadsDir $C_BEADS is not a directory"
  elif [ ! -r "$C_ATOM" ]; then contract_bad="contract atomScriptPath $C_ATOM is not readable"
  elif [ ! -r "$C_PCI" ]; then contract_bad="contract pciScriptPath $C_PCI is not readable"
  elif [ ! -r "$C_RUNEPIC" ]; then contract_bad="derived run-epic script $C_RUNEPIC is not readable"
  elif jhas "$CONTRACT" baseBranch && [ -z "$C_BASE" ]; then contract_bad="contract baseBranch is present but empty"
  elif jhas "$CONTRACT" implementModel && [ -z "$C_MODEL" ]; then contract_bad="contract implementModel is present but empty"
  fi
fi
if [ -n "$contract_bad" ]; then
  emit_abort "$contract_bad"
  W_ABORTS=$((W_ABORTS + 1))
  if [ "$W_ABORTS" -ge 3 ]; then
    W_RETIRED=true
  fi
  if ! write_state; then
    log "failed to persist watch state after a contract abort; timer left in place"
    exit 0
  fi
  if [ "$W_RETIRED" = "true" ]; then
    emit_expired "retired after 3 consecutive contract aborts"
    log "retired: 3 consecutive contract aborts"
    remove_timer
  fi
  exit 0
fi
W_ABORTS=0

# --- 4. consume the event log from the cursor ------------------------------
if [ -f "$EVENTS" ]; then
  END_BYTES=$(wc -c < "$EVENTS" | tr -d ' ')
else
  END_BYTES=0
fi
START=$W_OFFSET
if [ "$END_BYTES" -lt "$START" ]; then
  log "event log is smaller than the cursor ($END_BYTES < $START); resetting cursor to 0"
  START=0
fi
: > "$WIN"
: > "$WIN.lines"
CONSUMED=0
if [ "$END_BYTES" -gt "$START" ]; then
  tail -c +$((START + 1)) "$EVENTS" 2>/dev/null | dd bs=1 count=$((END_BYTES - START)) 2>/dev/null > "$WIN"
  NLINES=$(tr -cd '\n' < "$WIN" | wc -c | tr -d ' ')
  if [ "$NLINES" -gt 0 ]; then
    head -n "$NLINES" "$WIN" > "$WIN.lines"
    CONSUMED=$(wc -c < "$WIN.lines" | tr -d ' ')
  fi
fi

SAW_PR_OPEN=no
SAW_EPIC_COMPLETE=no
SAW_INFRA_FAIL=no
NEW_LASTSTOP=""
lastrunev=""
while IFS= read -r line; do
  case "$line" in anvil-epic\|*) ;; *) continue ;; esac
  case "$line" in *\|*\|*\|*\|*\|*) ;; *) continue ;; esac
  rest=${line#*|}; rest=${rest#*|}
  eid=${rest%%|*}; rest=${rest#*|}
  ev=${rest%%|*}; rest=${rest#*|}
  detail=${rest#*|}
  [ "$eid" = "$EPIC_ID" ] || continue
  case "$detail" in reinvoke-aborted*|reinvoke-cap-reached*|watch-expired*) continue ;; esac
  lastrunev="$ev"
  if [ "$ev" = "epic-pr-open" ]; then
    case "$detail" in *https://*) SAW_PR_OPEN=yes ;; esac
  fi
  if [ "$ev" = "stopped" ]; then
    case "$detail" in
      setup-failed*|frontier-agent-failed*)
        SAW_INFRA_FAIL=yes; NEW_LASTSTOP="$detail" ;;
      epic-complete*)
        SAW_EPIC_COMPLETE=yes; NEW_LASTSTOP="$detail" ;;
      no-ready-children*|wave-merged-zero-slices*|cut-falsified*|max-waves-reached*)
        NEW_LASTSTOP="$detail" ;;
    esac
  fi
done < "$WIN.lines"

[ -n "$NEW_LASTSTOP" ] && W_LASTSTOP="$NEW_LASTSTOP"
if [ -n "$lastrunev" ]; then
  if [ "$lastrunev" = "wave-start" ]; then W_INFLIGHT=true; else W_INFLIGHT=false; fi
fi
W_OFFSET=$((START + CONSUMED))
rm -f "$WIN" "$WIN.lines" 2>/dev/null
# Nothing is persisted yet. The new cursor, lastStoppedDetail, runInFlight and
# any retirement or infra-failure count from this window commit together in
# ONE write_state below, so an interrupted tick re-reads the same window
# instead of consuming it while dropping its effects.

# --- 5. every effect of the consumed window, committed atomically ------------
if [ "$SAW_PR_OPEN" = "yes" ]; then
  retire "epic PR is open"
  exit 0
fi
case "$W_LASTSTOP" in
  cut-falsified*)
    retire "cut falsified; a recut is human work"
    exit 0 ;;
esac
if [ "$W_INFLIGHT" != "true" ] && [ "$SAW_INFRA_FAIL" = "yes" ]; then
  W_REINVOKE=$((W_REINVOKE + 1))
fi
if ! write_state; then
  emit_abort "failed to persist watch state after reading the window"
  exit 0
fi

# --- 6. unblocked? ----------------------------------------------------------
if [ "$W_INFLIGHT" = "true" ]; then
  log "a run appears to be in flight (trailing wave-start); no-op"
  exit 0
fi
if [ "$SAW_INFRA_FAIL" = "yes" ]; then
  log "infrastructure stop in the window; waiting for the operator (reinvokeCount now $W_REINVOKE)"
  exit 0
fi

TRIGGER=no
case "$W_LASTSTOP" in
  no-ready-children*|wave-merged-zero-slices*|max-waves-reached*)
    ready=$(BEADS_DIR="$C_BEADS" bd ready --json 2>/dev/null | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
    kids=$(BEADS_DIR="$C_BEADS" bd show "$EPIC_ID" --json 2>/dev/null | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4 | grep -v "^$EPIC_ID\$")
    for k in $kids; do
      for r in $ready; do
        if [ "$k" = "$r" ]; then TRIGGER=yes; break; fi
      done
      [ "$TRIGGER" = "yes" ] && break
    done
    [ "$TRIGGER" = "yes" ] && log "unblocked: a child of $EPIC_ID is ready again"
    ;;
  epic-complete*)
    TRIGGER=yes
    log "epic-complete with no epic PR line; re-invoking to retry the PR step"
    ;;
esac
if [ "$TRIGGER" != "yes" ]; then
  exit 0
fi

# --- 7. cap -----------------------------------------------------------------
if [ "$W_REINVOKE" -ge 6 ]; then
  W_RETIRED=true
  if ! write_state; then
    emit_abort "failed to persist the cap retirement; timer left in place"
    exit 0
  fi
  emit_cap
  log "retired: re-invocation cap reached"
  remove_timer
  exit 0
fi

# --- 8. re-invoke -----------------------------------------------------------
# The guard requires git status to SUCCEED and print nothing: an inaccessible
# or non-git repoRoot also produces empty output, and must abort, not pass.
dirty=$(git -C "$C_REPO" status --porcelain 2>>"$WATCHLOG")
gitrc=$?
if [ "$gitrc" -ne 0 ]; then
  emit_abort "git status failed in $C_REPO (exit $gitrc)"
  exit 0
fi
if [ -n "$dirty" ]; then
  emit_abort "dirty worktree"
  exit 0
fi
if ! gh auth status >/dev/null 2>&1; then
  emit_abort "gh auth not usable"
  exit 0
fi

W_REINVOKE=$((W_REINVOKE + 1))
if ! write_state; then
  emit_abort "failed to persist reinvokeCount; refusing an uncounted invocation"
  exit 0
fi

ARGS_JSON="{\"epicId\": \"$EPIC_ID\", \"atomScriptPath\": \"$C_ATOM\", \"pciScriptPath\": \"$C_PCI\", \"maxWaves\": $C_MAXW"
if jhas "$CONTRACT" baseBranch; then ARGS_JSON="$ARGS_JSON, \"baseBranch\": \"$C_BASE\""; fi
if jhas "$CONTRACT" implementModel; then ARGS_JSON="$ARGS_JSON, \"implementModel\": \"$C_MODEL\""; fi
ARGS_JSON="$ARGS_JSON}"

# Every fixed character below is escaped so that ONLY the persisted values
# above interpolate: the scheduled session has no env and loads no skill.
PROMPT="You are resuming an anvil epic non-interactively. There is no operator in this session: never ask a question, never wait for input.
Invoke the Workflow tool with scriptPath \"$C_RUNEPIC\" and args $ARGS_JSON
Do not resolve any path yourself and do not load any skill — the paths above are absolute and final.
When the workflow returns, if stoppedBecause is one of max-waves-reached, frontier-agent-failed, epic-complete, cut-falsified, append exactly ONE line to the event log — and nothing at all for any other value, because every other token already has an agent producer and a second producer corrupts the stream:
  mkdir -p \"\$HOME/.anvil/runs\" && printf 'anvil-epic|%s|$EPIC_ID|stopped||<stoppedBecause>; <one clause>\\n' \"\$(date -u +%FT%TZ)\" >> \"\$HOME/.anvil/runs/epic-events.log\"
The six fields are anvil-epic|<utc-iso8601>|<epicId>|<event>|<sliceId>|<detail>; sliceId is EMPTY for a stop; the returned stoppedBecause goes verbatim at the start of the detail, followed by one clause of at most 200 chars. Inside every field replace | with / and CR/LF with spaces. An append that fails changes nothing else.
Then print a two-line summary — stoppedBecause, and the draft epic PR url if one was opened — and exit. Never merge anything."

log "re-invoking run-epic headlessly (reinvokeCount now $W_REINVOKE)"
wfdir=$(dirname "$C_ATOM") && cd "$C_REPO" && BEADS_DIR="$C_BEADS" "$CLAUDE_BIN" -p "$PROMPT" --permission-mode acceptEdits --add-dir "$HOME/.anvil" --add-dir "$wfdir" >> "$HOME/.anvil/runs/epic-$EPIC_ID.watch.log" 2>&1
log "headless run returned with status $?"
exit 0
```
<!-- ANVIL-TICK-TEMPLATE-END -->

### 7. Arm the platform timer

Only this step is platform-specific. The lock, the JSONs, the cursor,
retirement and the cap are platform-neutral file/bd state and must stay that way.

**macOS (launchd).** Write `~/Library/LaunchAgents/anvil-epic-<epicId>.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>anvil-epic-EPICID</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>/ABSOLUTE/HOME/.anvil/runs/epic-EPICID.tick.sh</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/ABSOLUTE/HOME/.anvil/runs/epic-EPICID.watch.log</string>
  <key>StandardErrorPath</key><string>/ABSOLUTE/HOME/.anvil/runs/epic-EPICID.watch.log</string>
</dict>
</plist>
```

Load it — on arm **and** on re-arm — bootout-first, because `bootstrap` fails on
an already-loaded label:

```sh
launchctl bootout "gui/$(id -u)/anvil-epic-<epicId>" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/anvil-epic-<epicId>.plist"
```

Fall back to `launchctl load` only where the `bootstrap` subcommand is
unsupported. The agent surfaces in Login Items as "sh / unidentified
developer" — that is expected. **Never cron on macOS.**

**Linux with systemd.** `~/.config/systemd/user/anvil-epic-<epicId>.service`:

```ini
[Unit]
Description=anvil watch tick for epic <epicId>

[Service]
Type=oneshot
ExecStart=/bin/sh /ABSOLUTE/HOME/.anvil/runs/epic-<epicId>.tick.sh
```

`~/.config/systemd/user/anvil-epic-<epicId>.timer`:

```ini
[Unit]
Description=anvil watch timer for epic <epicId>

[Timer]
OnBootSec=15min
OnUnitActiveSec=15min
Unit=anvil-epic-<epicId>.service

[Install]
WantedBy=timers.target
```

```sh
systemctl --user daemon-reload && systemctl --user enable --now anvil-epic-<epicId>.timer
```

`daemon-reload` is required whenever the unit files are rewritten — i.e. on
every re-arm.

**Linux without systemd (cron).** Idempotent install; the trailing comment is
the removal marker:

```sh
( crontab -l 2>/dev/null | grep -v '# anvil-epic-<epicId>$'; echo '*/15 * * * * /bin/sh <tick script path> # anvil-epic-<epicId>' ) | crontab -
```

Removal is the same pipeline without the `echo`.

### 8. Re-arming is idempotent

Refresh the contract JSON, the tick script and the timer definition, and
**preserve** the existing watch-state counters and cursor — the active-watch
branch of step 5: the watch-state file is not rewritten. Report that it
re-armed.

**Except** when the existing watch state has `retired` true. An explicit re-arm
is the sanctioned recovery from the cap, the expiry, a permanent-failure
retirement, or a falsified-then-recut epic: reset `reinvokeCount` and
`consecutiveAbortCount` to 0, `retired` to false, `armedAt` to now, and re-seed
`offsetBytes`, `runInFlight` and `lastStoppedDetail` per steps 4–5 — whose
arm-time refusals still apply. Log the reset in the watch log.

### 9. `off` disarms

`/anvil:watch-epic <epic-id> off` checks the lock (step 3), then performs the
retirement steps: write `retired: true` into the watch state, then remove the
timer — `launchctl bootout` / `systemctl --user disable --now` / the crontab
edit strictly last. The contract JSON and the watch log are kept as an audit
trail. Report what was removed.

## What the tick does, every 15 minutes

The script above is the contract; this is its shape in prose.

1. **Retired?** → exit 0.
2. **Lock.** `mkdir` the lock directory (the portable atomic primitive), write
   `$$` to `<lock>/pid`. On failure: read the pid and `kill -0` it. Live → exit
   0, no action. Dead → stale: remove and re-acquire. Unreadable pid → re-read
   five times at one-second intervals, then treat the lock as HELD and exit 0 —
   a racing tick sits between its `mkdir` and its pid write, and a missing pid
   file is never proof of staleness. The lock is held until the tick fully
   finishes, **including the invoked run** (run-epic can run for hours; ticks
   during it correctly no-op), and released on every exit path via `trap`.
3. **Validate** both JSONs — first the frozen layout itself (exact key order,
   uniqueness, allowed-key set, one double-quoted value per line), then types,
   ranges, identity, paths. Any failure appends
   `stopped||reinvoke-aborted; <what was missing>` and exits 0 without calling
   run-epic. **Never recreate or default watch state**: offset 0 would replay
   the whole shared log and `reinvokeCount` 0 would bypass the cap. Recovery is
   an explicit operator re-arm. When the watch state itself is readable, each
   such abort increments `consecutiveAbortCount`; any tick that passes
   validation resets it to 0; at 3 the watch retires with
   `stopped||watch-expired; retired after 3 consecutive contract aborts`. When
   the watch state is what is unreadable the counter cannot advance and the
   timer keeps aborting until the operator re-arms or disarms — that residual
   noise is the accepted floor. Absolute expiry: `armedAt` older than 604800 s
   retires with `stopped||watch-expired; 7-day watch expiry`.
4. **Consume** `epic-events.log` from `offsetBytes`. One snapshot end byte is
   taken before reading; only complete newline-terminated lines below it are
   processed; the new offset is `start + bytes consumed` — **never** a file size
   measured after processing, which would swallow everything appended while the
   tick (and its invoked run) ran. A file smaller than the cursor means the
   operator removed or truncated it: reset to 0. Only lines whose third field is
   this epic count; split on the first five pipes; file order is the only
   ordering (1-second timestamps forbid timestamp sorts). Nothing is persisted
   at this point — the cursor commits together with the window's effects in
   step 5.
5. **Commit, then retire?** Every effect of the consumed window — the new
   cursor, `lastStoppedDetail`, `runInFlight`, an `epic-pr-open` retirement,
   an infra-failure count — is decided first and persisted in ONE
   `write_state`; a failed write aborts the tick (`reinvoke-aborted`) without
   consuming the window, and no timer is ever removed before `retired: true`
   is durably on disk. A valid `epic-pr-open` line → retire.
   `lastStoppedDetail` beginning `cut-falsified` → retire. An `epic-complete`
   with no `epic-pr-open` **never** retires — run-epic can report
   epic-complete when the PR step failed, and a re-run must retry it.
6. **Unblocked?** `runInFlight` → exit without invoking and without counting.
   A new `setup-failed` / `frontier-agent-failed` → do not invoke, but increment
   `reinvokeCount` so the cap bounds how long a broken epic keeps its timer.
   Otherwise invoke when `lastStoppedDetail` begins `no-ready-children`,
   `wave-merged-zero-slices` or `max-waves-reached` **and** a child of the epic
   appears in `bd ready`; or when it begins `epic-complete` and step 5 did not
   retire (PR retry — no bd-ready requirement, the children are all done).
7. **Cap.** `reinvokeCount` ≥ 6 → persist `retired: true` (a failed persist
   aborts, leaving the timer), append `reinvoke-cap-reached`, then remove the
   timer.
8. **Re-invoke.** Guard (`git status` must **succeed** and print nothing — a
   failing or unreachable repoRoot is an abort, not a clean tree — plus usable
   `gh auth`) → increment and persist, where a failed persist aborts the
   invocation so no run ever proceeds uncounted → invoke. That order is fixed:
   a crashed run still counts, and a transient guard failure never counts and
   never retires.

The tick's `lastStoppedDetail` only ever tracks the seven run-epic tokens —
`setup-failed`, `frontier-agent-failed`, `no-ready-children`,
`wave-merged-zero-slices`, `cut-falsified`, `max-waves-reached`,
`epic-complete` — matched by prefix. Only `cut-falsified` is terminal for
re-invocation.

## Events the watch appends

Six pipe-separated fields, exactly as every other anvil epic event:

```
anvil-epic|<utc-iso8601>|<epicId>|<event>|<sliceId>|<detail>
```

The watch owns exactly three detail tokens — `reinvoke-aborted`,
`reinvoke-cap-reached` and `watch-expired` (consecutive aborts or the 7-day
expiry) — always as a `stopped` event with an **empty** sliceId and the token
first in the detail. Inside every field `|` becomes `/` and CR/LF become spaces;
the detail is one clause of at most 200 chars. The two printf templates, copied
verbatim into the tick script:

```sh
reason=$(printf '%s' "<what was missing>" | tr '|' '/' | tr '\r\n' '  ' | cut -c1-200) ; mkdir -p "$HOME/.anvil/runs" && printf 'anvil-epic|%s|%s|stopped||reinvoke-aborted; %s\n' "$(date -u +%FT%TZ)" "$EPIC_ID" "$reason" >> "$HOME/.anvil/runs/epic-events.log"
```

```sh
mkdir -p "$HOME/.anvil/runs" && printf 'anvil-epic|%s|%s|stopped||reinvoke-cap-reached; after 6 re-invocations\n' "$(date -u +%FT%TZ)" "$EPIC_ID" >> "$HOME/.anvil/runs/epic-events.log"
```

Emission is observational and best-effort: an append failure goes to the watch
log and never changes tick behavior. **Never append any other event** — every
other token already has exactly one producer, and a second producer corrupts the
stream.

## Verifying it works

The end-to-end shape, for an operator who wants to see it with their own eyes:

1. Run `/anvil:run-epic <epic>` until it stops with `no-ready-children` (a slice
   stalled at a draft PR).
2. `/anvil:watch-epic <epic>` — it reports the seeded `lastStoppedDetail`, the
   cursor at end-of-file, and the armed timer name.
3. Confirm the timer exists: `launchctl list | grep anvil-epic-<epic>` (macOS)
   or `systemctl --user list-timers | grep anvil-epic-<epic>` / `crontab -l`.
4. Adjudicate the stalled slice in beads so a child returns to `bd ready`.
5. Within one interval (≤ 15 min) the epic resumes with **no** operator
   invocation. Watch it in `tail -f ~/.anvil/runs/epic-<epic>.watch.log`, and
   the boundary events in `grep 'anvil-epic|' ~/.anvil/runs/epic-events.log`.
6. A tick that fires during that run no-ops on the lock — the watch log says
   `lock held by live pid …`.
7. When the epic finishes, the draft epic PR opens, the next tick sees the
   `epic-pr-open` line, and the timer disappears from the platform's timer list.

Anything that goes wrong leaves a line in
`~/.anvil/runs/epic-<epic>.watch.log`; anything the rest of anvil needs to know
leaves one of the three watch tokens in `epic-events.log`.

## Hard rules

- **Never merge.** The watch re-enters run-epic, which itself never merges to
  the default branch; the epic still ends at ONE draft PR the operator
  adjudicates.
- **Never shell out to `forge`.** Only `claude`, `gh`, `bd`/`br`, `git`, the
  platform's own scheduler, and the Workflow tool.
- **Zero repo imposition.** Every file this skill creates lives under
  `~/.anvil/` or the platform's per-user timer directory. Nothing is written
  into the target repo, its `CLAUDE.md`, or a `.beads` file.
- **Never edit the operator's settings.** A missing `permissions.allow` grant is
  a refusal with a pointer at `update-config`, not a fix you apply.
- **Never modify `run-epic.js` or `run-epic/SKILL.md`.** The event format, the
  token list, the JSON shapes and the file names are seam contracts; this skill
  consumes them and adds nothing.
- **Do not invent** additional events, tokens, state files or timer names, do
  not read the monitor (it is best-effort and interactive-only — read the FILE),
  and do not sort the log by timestamp.
