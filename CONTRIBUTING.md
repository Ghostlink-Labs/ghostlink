# Contributing

GhostLink is an experimental development project. Read the [setup guide](docs/SETUP.md), [threat model](docs/THREAT-MODEL.md) and relevant [protocol decisions](docs/adr/) before changing authorization, cryptography or account formats.

Use a feature branch and Conventional Commit messages. Describe the concrete problem, resulting behavior, verification and limitations in each pull request.

Run the checks relevant to your change. Shared contract or release changes require the TypeScript build/typecheck/test gates and Rust unit/LiteSVM tests. Circuit changes require coordinated proving and verifying-key updates in a development branch. Never regenerate production keys, deploy programs or publish a package as part of a routine code change.

Add a small regression test when authorization, funds, persistence or an important integration can regress. Avoid claims that tests prove the absence of vulnerabilities.

Do not commit credentials, identity secrets, real keypairs, private RPC URLs, environment files, local ledgers or proving keys. Test fixtures in `circuits/keys/` are public proofs and verification data.

Keep contributions within the SDK, protocol, circuits, reference services and technical documentation. Private product applications, designs and brand assets must stay outside this repository and its Git history.

By contributing, you agree that your contribution is available under the repository's Apache-2.0 license.
