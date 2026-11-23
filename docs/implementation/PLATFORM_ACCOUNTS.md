# Account provisioning and workspace access

Issue #4 and draft PR #22 implement the platform account foundation. The setup, migration commands, API routes and test instructions are in [Platform accounts](PLATFORM_AUTH.md).

| Object | Responsibility |
| --- | --- |
| `platform.user_profiles` | Server-owned plan and profile for an opaque auth user ID. |
| `platform.workspaces` and `platform.workspace_members` | Personal workspace, ownership, and membership role used by the private workspace endpoint. |
| `platform.credit_wallets` and `platform.credit_entries` | Wallet and credit history. A unique signup key limits the starter grant to one entry. |
| `platform.account_events` | Records the trusted account-created event, including zero-credit signups. |
| `platform.account_deletions` | Records committed deletions for late-event suppression and downstream asset cleanup. |

The maintained auth adapter owns its credential, verification, rate-limit and session tables. The lifecycle trigger calls `platform.provision_account_created` when it inserts an identity. A per-user transaction lock serializes account events and deletion. Profile and workspace reads resolve the authenticated user on the server and perform read-only queries.

The starter allocation and private profile are available on Free and Premium plans. Billing and entitlement changes are tracked in #5 and #19.
