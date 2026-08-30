# Security Policy

## Reporting a vulnerability

Email **security@wasmpeg.com**. Please don't open a public issue for
suspected vulnerabilities — wasmpeg wraps a large C codebase (FFmpeg) and
memory-safety issues in the decode/parse paths are the kind of thing that
deserves a coordinated fix before public disclosure.

Include what you'd normally include: affected version/commit, the input or
call sequence that triggers it, and impact if you know it (crash vs. OOB
read/write vs. something else).

We'll acknowledge within a few days and keep you posted as we work on a fix.

## Supported versions

wasmpeg is pre-release; until the first tagged version, only the `main`
branch is supported. Once releases start, this section will list which
versions still get security fixes.
