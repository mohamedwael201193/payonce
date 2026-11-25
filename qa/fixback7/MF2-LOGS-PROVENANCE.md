# MF2 logs — provenance

These four logs were NOT run by the fix-back-8 builder. They are the
fix-back-7 ADVERSARIAL judge's own independent live reproductions, run
2026-11-25T13:37:10Z / 13:38:27Z / 13:39:33Z (hide runs 1–3) and
13:40:52Z (enum) in the judge's fresh clone of PR #1 head `c9bbffd`,
stub PID 29796 port 7401, Chrome headless-shell 159.0.8154.6, fresh
dist chunk 530,281 B sha `632d5957…`. Source:
`batch-d/judge-fixback7-adversarial/mf2-hide-my-run{1,2,3}.log` and
`mf2-enum-my-run.log`, copied byte-for-byte (sha256 values in
FIXBACK8_REPORT.md §2.1 — verify with `sha256sum` after copying).
Filed here to close honesty MF-FB7-H1 / OBS-FB7-A1: the fb7 claim
"42/42 ×3" is now evidenced by three distinct run logs with
run-identifying headers. Hide count arithmetic: 5+32+1+1+1+2 = 42.

## Files

| Filed name | Source name | sha256 | PASS lines |
|---|---|---|---|
| `mf2-hide-my-run1.log` | `mf2-hide-my-run1.log` | `feaed116ba3a23e54676fc07792ab7ddf97b80e11bcf18ee523c0589cd22c018` | 42 |
| `mf2-hide-my-run2.log` | `mf2-hide-my-run2.log` | `44eb514f27ef9ad3e5d89101268e1621e56f0b07801ff0de7b50cc6e98cbdb11` | 42 |
| `mf2-hide-my-run3.log` | `mf2-hide-my-run3.log` | `0bfea53d45dbfdadbab1f9918ad10ac43c36108e1234e8cac0cf395afca18011` | 42 |
| `mf2-enumeration-judge-run.log` | `mf2-enum-my-run.log` | `65cf98d19fc9fccfb836f33a0b477893ecc8b67de259ab979f648a9ab9c21063` | 26 |

The enum log is corroboration of the already-filed
`mf2-enumeration.log`; it is named distinctly so it is not confused
with a builder run.
