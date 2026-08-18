#!/usr/bin/env bash
#
# Provision and inspect the CockroachDB Cloud cluster behind this project.
#
#   ./scripts/provision.sh preflight   # offline checks, no credentials needed
#   ./scripts/provision.sh inspect     # read-only: state, region, limits, spend
#   ./scripts/provision.sh provision   # create the cluster and the SQL user (default)
#
# Install the CLI first:
#   brew install cockroachdb/tap/ccloud
#   ccloud auth login
#
# Verified against ccloud 0.8.23 (CCAPI 2024-09-16). Every subcommand and flag used below
# was checked against that binary's own --help output, because the previous version of this
# script was written from documentation and three of its four commands did not parse.
# `preflight` re-runs those checks so a version bump that renames a flag fails loudly here
# rather than halfway through creating billable infrastructure.
#
# Authentication is interactive by design. ccloud 0.8.23 has no API-key or environment
# variable login path: `ccloud auth login` accepts only --no-redirect, --org and
# --vanity-name, and --no-redirect still needs a human to fetch a code from a browser on
# another machine. Service-account API keys authenticate the Cloud REST API, not this CLI.
# See docs/operations.md.

set -euo pipefail

CLUSTER="${CLUSTER:-tredecim}"
SQL_USER="${SQL_USER:-tredecim_app}"

# --cloud is validated case-sensitively against [GCP AWS AZURE] before the CLI even checks
# whether you are logged in, so lowercase "aws" is a hard error. The region is a positional
# argument; there is no --region flag.
CLOUD="${CLOUD:-AWS}"
REGION="${REGION:-us-east-1}"

# There is no --spend-limit flag. Basic clusters are capped per resource instead, and these
# two values are the free monthly allowance that every pay-as-you-go organization already
# receives (50M Request Units + 10 GiB, together worth about $15). Capping at exactly the
# allowance means the cluster cannot generate an invoice. Raise them if the demo needs
# headroom: hitting the storage limit blocks writes and hitting the RU limit disables the
# cluster until the next billing cycle.
REQUEST_UNIT_LIMIT="${REQUEST_UNIT_LIMIT:-50000000}"
STORAGE_GIB_LIMIT="${STORAGE_GIB_LIMIT:-10}"

die() { echo "error: $*" >&2; exit 1; }
note() { echo "==> $*"; }

require_cli() {
  command -v ccloud >/dev/null 2>&1 || die "ccloud not found. Install it with:
    brew install cockroachdb/tap/ccloud
  or download a release for your platform from
    https://github.com/cockroachdb/ccloud-cli/releases"
  command -v jq >/dev/null 2>&1 || die "jq not found. Install it with: brew install jq"
}

# Every network-touching subcommand exits 1 with "not logged in" when there are no stored
# credentials. Checking once up front turns that into one actionable message instead of the
# same error surfacing from whichever call happens to run first.
require_auth() {
  if ! ccloud auth whoami >/dev/null 2>&1; then
    cat >&2 <<'MSG'
error: ccloud is not authenticated, and it cannot authenticate itself.

  Run this once, as a human, on a machine with a browser:

      ccloud auth login

  On a headless box, run `ccloud auth login --no-redirect`, open the printed URL on
  another machine, and paste the authorization code back.

  There is no unattended path. ccloud 0.8.23 reads no API-key environment variable;
  service-account keys (`ccloud service-account api-key create`) authenticate the Cloud
  REST API at https://cockroachlabs.cloud/api/v1/ via an Authorization: Bearer header,
  not this CLI. To automate provisioning, call that REST API directly.
MSG
    exit 1
  fi
}

# `cluster list --output json` returns the SDK's ListClustersResponse, which wraps the array
# in a "clusters" key alongside pagination. Older builds printed a bare array. Accepting
# both costs one line and removes a silent-empty-result failure mode. The previous version
# of this script grepped for the literal string '"name": "tredecim"', which depended on the
# encoder's exact spacing.
cluster_record() {
  ccloud cluster list --output json \
    | jq -c --arg n "$CLUSTER" \
        '(if type == "array" then . else (.clusters // []) end)
         | map(select(.name == $n)) | first // empty'
}

cmd_preflight() {
  require_cli
  note "ccloud binary"
  command -v ccloud
  ccloud version

  # Assert the exact surface this script drives. A missing flag here means the CLI changed
  # and the provision path below would fail after partially applying changes.
  note "verifying the subcommands and flags this script uses"
  local ok=0
  check_flag() {
    local subcmd="$1" flag="$2" help
    # $subcmd is deliberately unquoted so it splits into words. The help text is captured
    # into a variable and matched in-process rather than piped to `grep -q`: grep -q exits
    # on the first match, ccloud then dies of SIGPIPE, and `set -o pipefail` reports the
    # whole pipeline as failed. That misfires only when the match is near the top of the
    # output, which is why it looked like it worked.
    help=$(ccloud $subcmd --help 2>&1 || true)
    if [[ "$help" == *"$flag"* ]]; then
      printf '  %-7s ccloud %s  [%s]\n' "ok" "$subcmd" "$flag"
    else
      printf '  %-7s ccloud %s  [%s]\n' "MISSING" "$subcmd" "$flag"
      ok=1
    fi
  }
  check_flag "cluster create" "--cloud"
  check_flag "cluster create" "--request-unit-limit"
  check_flag "cluster create" "--storage-gib-limit"
  check_flag "cluster create" "--wait"
  check_flag "cluster list" "--output"
  check_flag "cluster info" "<cluster name>"
  check_flag "cluster user create" "--password"
  check_flag "cluster connection-string" "--sql-user"
  check_flag "billing invoice list" "List invoices"
  [ "$ok" -eq 0 ] || die "the installed ccloud does not match this script"

  note "credentials"
  if ccloud auth whoami 2>/dev/null; then
    echo "  authenticated"
  else
    echo "  not logged in (expected before 'ccloud auth login'); 'inspect' and 'provision' will refuse to run"
  fi
}

cmd_inspect() {
  require_cli
  require_auth

  note "organization"
  ccloud organization info

  note "clusters"
  ccloud cluster list

  local rec
  rec=$(cluster_record)
  [ -n "$rec" ] || die "no cluster named '${CLUSTER}' in this organization. Run: $0 provision"

  note "cluster ${CLUSTER}"
  # storage_mib_limit is the API's field name even though the flag that sets it is
  # --storage-gib-limit, so it is converted back here to match what was requested.
  printf '%s' "$rec" | jq -r '
    "  id            : \(.id)",
    "  plan          : \(.plan // "unknown")",
    "  state         : \(.state // "unknown")",
    "  cloud         : \(.cloud_provider // "unknown")",
    "  regions       : \([.regions[]?.name] | join(", "))",
    "  version       : \(.cockroach_version // "unknown")",
    "  created       : \(.created_at // "unknown")",
    "  sql host      : \(.sql_dns // "unknown")",
    "  RU limit      : \(.config.serverless.usage_limits.request_unit_limit // "unlimited")",
    "  storage limit : \(if .config.serverless.usage_limits.storage_mib_limit
                         then "\(.config.serverless.usage_limits.storage_mib_limit / 1024) GiB"
                         else "unlimited" end)"'

  note "SQL users"
  ccloud cluster user list "$CLUSTER"

  note "spend"
  ccloud billing invoice list
}

cmd_provision() {
  require_cli
  require_auth

  local rec
  rec=$(cluster_record)

  if [ -n "$rec" ]; then
    note "cluster ${CLUSTER} already exists (state: $(printf '%s' "$rec" | jq -r '.state // "unknown"'))"
  else
    note "creating ${CLUSTER} as a BASIC cluster in ${CLOUD}/${REGION}"
    # --wait blocks until the cluster is usable. Without it the SQL user creation below
    # races cluster startup.
    ccloud cluster create BASIC "$CLUSTER" "$REGION" \
      --cloud "$CLOUD" \
      --request-unit-limit "$REQUEST_UNIT_LIMIT" \
      --storage-gib-limit "$STORAGE_GIB_LIMIT" \
      --wait
  fi

  # There is no --generate-password flag; -p/--password is the only way to set one, so the
  # password is generated here. openssl rather than `tr -dc < /dev/urandom | head`, because
  # head closing the pipe kills tr with SIGPIPE and `set -o pipefail` would abort the script.
  local generated=0
  if [ -z "${SQL_PASSWORD:-}" ]; then
    SQL_PASSWORD=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9')
    SQL_PASSWORD=${SQL_PASSWORD:0:24}
    generated=1
  fi

  note "creating SQL user ${SQL_USER}"
  # The password appears in this process's argv and is therefore visible to `ps` for the
  # lifetime of the call. ccloud 0.8.23 offers no stdin or prompt alternative. On a shared
  # machine, create the user in the Cloud console instead.
  ccloud cluster user create "$CLUSTER" "$SQL_USER" --password "$SQL_PASSWORD"

  note "connection string"
  # `cluster sql --connection-url` opens a shell unless asked otherwise; connection-string
  # is the non-interactive command and takes the SQL user directly. Neither embeds the
  # password, so it has to be spliced in below.
  ccloud cluster connection-string "$CLUSTER" --sql-user "$SQL_USER"

  # No CA download. Basic clusters present a publicly-trusted certificate, so the system
  # trust store verifies them and lib/db.ts falls through to exactly that when no cert file
  # is present. The previous version of this script unconditionally curled a cluster cert
  # into ~/.postgresql/root.crt without --fail, so any non-200 response wrote its error body
  # to that path and lib/db.ts would then pin a garbage CA. Advanced clusters, which do use
  # a private CA, are handled by `ccloud cluster sql --cert-path`.

  echo
  if [ "$generated" -eq 1 ]; then
    note "generated password for ${SQL_USER} (shown once, not stored anywhere):"
    echo "    ${SQL_PASSWORD}"
    echo "    Rotate it with: ccloud cluster user password ${CLUSTER} ${SQL_USER}"
    echo
  fi
  echo "Put the connection string in .env.local as DATABASE_URL, with the password spliced"
  echo "into the user:password position, then run:"
  echo "    npm run migrate && npm run seed && npm run verify"
}

case "${1:-provision}" in
  preflight) cmd_preflight ;;
  inspect)   cmd_inspect ;;
  provision) cmd_provision ;;
  -h|--help|help)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *) die "unknown command '$1'. Use: preflight | inspect | provision" ;;
esac
