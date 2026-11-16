# Merge lane

A pull request by `kurts-bots[bot]` or `kurtlieber` merges itself after the
claude-worker has reviewed its head and the required `test` check passes,
unless it touches a path in `kurt-only.txt`. Kurt merges those, and every pull
request by anyone else. The commit status `merge-lane` on each pull request
says what the lane decided. Label a pull request `waiting-on-kurt` to hold it
for Kurt.

The lane is defined in kurtlieber/dotfiles: `tools/merge-lane/README.md` there
explains it, and ADR 0080 section 6 records the decision.
`.github/workflows/merge-lane.yml`, `.github/workflows/merge-lane-review.yml`
and `merge_lane.py` here are byte-identical copies of the dotfiles files, which
carry the tests. Edit them in dotfiles, then copy. Only `kurt-only.txt` is
Stage's own: it holds the gate.
