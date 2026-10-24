# Security policy

The maintained release is the current gaeru branch of thien-gaeru/gaeru. Dependency versions and checks are recorded in package-lock.json and CI; this policy does not declare older releases supported.

Report suspected vulnerabilities privately to the GAERU owner through an established support contact. Do not post keys, customer data, session cookies or exploit details in a public issue. Use GitHub private vulnerability reporting if enabled for the repository. No response-time commitment has been established.

Security fixes should include a regression test and a recoverable source backup. Never rotate the session or MFA encryption key without a migration and recovery plan. Never use production customer data in public test fixtures.

See docs/admin-security-review.md for the scoped review, evidence and remaining infrastructure checks. Passing automated checks is not a penetration-test certification.
