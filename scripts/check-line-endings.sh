#!/bin/sh
# Fails when a file that Linux will execute contains a CRLF line ending.
#
# WHY THIS EXISTS
# ---------------
# Several files in this repository are bind-mounted from the host straight into
# a Linux container and executed there, unmodified:
#
#   scripts/init-token.sh            -> /usr/local/bin/init-token.sh   (mcp-token)
#   integrations/gmail/entrypoint.sh -> /home/node/entrypoint.sh       (gmail-mcp)
#   scripts/check_setup.py           -> run by python3 from the harness
#
# Git converts line endings at checkout. With core.autocrlf=true — the default
# on Windows — those files arrive with CRLF, and the container fails at startup:
#
#   /usr/local/bin/init-token.sh: 14: set: Illegal option -
#   service "mcp-token" didn't complete successfully: exit 2
#
# `/bin/sh` is dash in Debian-based images, and it parses `set -eu\r` as the
# option string "eu\r", where \r is not a valid option letter. A `#!/usr/bin/env
# python3` script fails earlier still: `env: 'python3\r': No such file or
# directory`. Neither message names the line ending, so the cause is invisible
# from the error alone. This check names it.
#
# The `.gitattributes` rules are the actual fix; this is the regression test that
# keeps them honest, including for a contributor who never sets core.autocrlf.
#
# Usage:
#   sh scripts/check-line-endings.sh        # exits 1 on any CRLF
#   sh scripts/check-line-endings.sh --fix  # rewrites offending files as LF
#
# `--fix` is safe here: every file it touches is a text script whose only valid
# form is LF. It never modifies a certificate or a binary.
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

# Files whose line endings are a correctness requirement, not a preference.
# Anything an interpreter reads inside a Linux container belongs here.
is_checked() {
  case "$1" in
    *.sh) return 0 ;;
    *.py) return 0 ;;
    *.cjs) return 0 ;;
    *.mjs) return 0 ;;
    */Dockerfile) return 0 ;;
    *.dockerfile) return 0 ;;
    *) return 1 ;;
  esac
}

# Count CR bytes. `grep -c` exits 1 when it matches nothing, which is not an
# error here; `|| true` keeps `set -u` happy without masking a real failure.
count_cr() {
  n=$(grep -c "$(printf '\r')" "$1" 2>/dev/null) || n=0
  echo "${n:-0}"
}

printf '\n line endings: scanning %s\n' "$ROOT"

checked=0
bad=0
fixed=0

# `find | while read` rather than `for path in $(find ...)`: word splitting would
# break on a checkout under a path containing a space, which is very common on
# Windows (`C:\Users\John Smith\ai`), and the loop would silently check nothing.
# The pipe runs the loop in a subshell, so the final counts are computed by a
# second cheap pass below instead of being carried out in variables.

find "$ROOT" \
      -type d \( -name .git -o -name node_modules -o -name runtime -o -name data \) -prune -o \
      -type f -print 2>/dev/null | sort |
while IFS= read -r path; do
  rel=${path#"$ROOT"/}
  is_checked "$rel" || continue
  checked=$((checked+1))

  cr=$(count_cr "$path")
  [ "$cr" -eq 0 ] && continue

  if [ "$FIX" -eq 1 ]; then
    # tr into a temp file, then cat back over the original: `sed -i` is not
    # portable and `mv` would replace the inode, which breaks the single-file
    # bind mounts this repository relies on.
    tmp="${path}.lf.$$"
    if tr -d '\r' < "$path" > "$tmp" && cat "$tmp" > "$path"; then
      fixed=$((fixed+1))
      printf ' FIXED   %s (%s CRLF line(s) -> LF)\n' "$rel" "$cr"
    else
      bad=$((bad+1))
      printf ' FAILED  %s (could not rewrite)\n' "$rel"
    fi
    rm -f "$tmp"
  else
    bad=$((bad+1))
    printf ' CRLF    %s (%s line(s))\n' "$rel" "$cr"
  fi
done

# The loop above reports per file. These two passes produce the summary: a string
# comparison of counts is cheaper and less error-prone than coaxing variables out
# of a subshell.
total_checked=$(find "$ROOT" \
      -type d \( -name .git -o -name node_modules -o -name runtime -o -name data \) -prune -o \
      -type f -print 2>/dev/null |
      while IFS= read -r p; do is_checked "${p#"$ROOT"/}" && echo x; done | wc -l | tr -d ' ')

remaining=$(find "$ROOT" \
      -type d \( -name .git -o -name node_modules -o -name runtime -o -name data \) -prune -o \
      -type f -print 2>/dev/null |
      while IFS= read -r p; do
        is_checked "${p#"$ROOT"/}" || continue
        [ "$(count_cr "$p")" -gt 0 ] && echo x
      done | wc -l | tr -d ' ')

printf ' ─────────────────────────────────────────────────────────────\n'
if [ "$remaining" -eq 0 ]; then
  printf ' line endings: OK — %s file(s) checked, all LF\n\n' "$total_checked"
  exit 0
fi

if [ "$FIX" -eq 1 ]; then
  printf ' line endings: STILL BROKEN — %s of %s file(s) still contain CRLF\n\n' "$remaining" "$total_checked"
  exit 1
fi

printf ' line endings: FAIL — %s of %s file(s) contain CRLF\n' "$remaining" "$total_checked"
printf '\n These files are executed by /bin/sh or python3 inside a Linux container.\n'
printf ' CRLF makes the interpreter read "set -eu\\r" and abort with\n'
printf ' "set: Illegal option -", or makes env chase a program named "python3\\r".\n\n'
printf ' Fix on this machine:\n'
printf '   sh scripts/check-line-endings.sh --fix\n\n'
printf ' Fix for everyone (what prevents it from returning):\n'
printf '   cp docs/gitattributes.txt .gitattributes    # if not present yet\n'
printf '   git add --renormalize . && git commit -m "normalise line endings to LF"\n\n'
printf ' The rules in .gitattributes override core.autocrlf, so a fresh Windows\n'
printf ' clone gets LF even when the local Git configuration says otherwise.\n\n'
exit 1
