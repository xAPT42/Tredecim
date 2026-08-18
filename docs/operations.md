# Operating the cluster from the command line

`scripts/provision.sh` drives the CockroachDB Cloud control plane through the `ccloud` CLI.
Three modes:

```bash
./scripts/provision.sh preflight   # offline checks, no credentials needed
./scripts/provision.sh inspect     # read-only: state, region, limits, spend
./scripts/provision.sh provision   # create the cluster and the SQL user
```

## preflight, and why it exists

Every subcommand and flag the script uses is asserted against the installed binary's own
`--help` output before anything runs:

```
==> ccloud binary
/opt/homebrew/bin/ccloud
ccloud 0.8.23
CCAPI  2024-09-16
==> verifying the subcommands and flags this script uses
  ok      ccloud cluster create  [--cloud]
  ok      ccloud cluster create  [--request-unit-limit]
  ok      ccloud cluster create  [--storage-gib-limit]
  ok      ccloud cluster create  [--wait]
  ok      ccloud cluster list  [--output]
  ok      ccloud cluster info  [<cluster name>]
  ok      ccloud cluster user create  [--password]
  ok      ccloud cluster connection-string  [--sql-user]
  ok      ccloud billing invoice list  [List invoices]
==> credentials
  not logged in (expected before 'ccloud auth login')
```

This is not ceremony. The first version of this script was written from documentation and
never executed, and **three of its four commands did not parse**. The real CLI differs in
ways documentation does not lead you to expect:

- `--cloud` is validated case-sensitively against `[GCP AWS AZURE]`, and checked *before*
  the CLI verifies you are logged in, so lowercase `aws` fails with a confusing error.
- The region is a positional argument. There is no `--region` flag.
- There is no `--spend-limit`. Basic clusters are capped per resource, with
  `--request-unit-limit` and `--storage-gib-limit`.
- There is no `--generate-password`; `--password` is the only way to set one.

A script that has never run is a liability rather than an asset, and `preflight` is how this
one stays honest across CLI upgrades: a renamed flag fails loudly here rather than halfway
through creating billable infrastructure.

## Authentication is interactive, by design

`ccloud 0.8.23` has no unattended login path. `ccloud auth login` accepts only
`--no-redirect`, `--org` and `--vanity-name`, and even `--no-redirect` requires a human to
fetch an authorization code from a browser. There is no API-key environment variable.

Service-account keys, `ccloud service-account api-key create`, authenticate the Cloud
REST API at `https://cockroachlabs.cloud/api/v1/` with an `Authorization: Bearer` header.
They do not authenticate this CLI. Fully automated provisioning means calling that REST API
directly rather than driving `ccloud`.

So `inspect` and `provision` refuse to run rather than failing halfway:

```
error: ccloud is not authenticated, and it cannot authenticate itself.

  Run this once, as a human, on a machine with a browser:

      ccloud auth login
```

## Spend limits

The defaults cap the cluster at exactly the free monthly allowance every pay-as-you-go
organisation already receives, 50M Request Units and 10 GiB, together worth about $15 
so the cluster cannot generate an invoice.

Raise them if a demo needs headroom, and know what hitting them does: the storage limit
blocks writes, and the RU limit disables the cluster until the next billing cycle.

## After provisioning

```bash
npm run migrate       # apply lib/schema.sql, idempotently
npm run seed          # a small backdated history for the console
npm run schema-check  # confirm the deployed schema matches what the code depends on
npm run verify        # 64 assertions against the live cluster
```

`schema-check` is worth running after any control-plane change. See [mcp.md](mcp.md) for
what it inspects and why the deployed schema is the only one worth trusting.
