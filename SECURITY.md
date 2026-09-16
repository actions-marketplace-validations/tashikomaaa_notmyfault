# Security policy

## Supported versions

Security fixes are released for the latest `v1` version. The `v1` tag always points to it.

## Reporting a vulnerability

Please do not open a public issue.

Report vulnerabilities privately through [GitHub security advisories](https://github.com/tashikomaaa/notmyfault/security/advisories/new). Include what an attacker could achieve, the steps or workflow to reproduce it, and the notmyfault version.

You should receive an answer within a week. Once a fix is released, the advisory is published with credit to the reporter, unless you prefer to stay anonymous.

## Scope

notmyfault runs inside your workflows with the token you give it. Of particular interest:

- leaking the token or making it usable by untrusted code;
- a crafted JUnit report or test name that injects content into the pull request comment beyond plain text;
- writing to anything other than the history branch and pull request comments.

How notmyfault handles tokens and data is described in [Permissions and security](docs/security.md).
