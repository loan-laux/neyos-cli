# neyos-cli

Command line for the [Neyos](https://www.neyos.fr) tracker backoffice
(platform.neyos-equipment.com): list trackers and their state, read position
history, check and push configurations, and manage webhook endpoints.

It calls the same API as the web backoffice, signed in with your backoffice
account, so it can do what that account can do in the browser. It is not an
official Neyos tool, and the API it relies on is undocumented: a backoffice
update can break it.

## Install

Requires Node.js 22 or later. No dependencies.

```sh
npm install -g github:loan-laux/neyos-cli
```

Or from a clone:

```sh
git clone https://github.com/loan-laux/neyos-cli.git
cd neyos-cli
npm link
```

## Sign in

```sh
neyos login
```

Prompts for your backoffice email and password (the password is not echoed)
and saves the session token to `~/.config/neyos/token.json` (or
`$XDG_CONFIG_HOME/neyos/token.json`), readable only by you. The password itself
is not stored. Set `NEYOS_TOKEN` to use a token without the file.
`neyos logout` revokes the token and deletes the file.

## Commands

| Command | What it does |
| --- | --- |
| `neyos whoami` | The signed-in account |
| `neyos trackers` | Every tracker: online, battery, age of the last point, network, configuration, pending actions |
| `neyos tracker <alias>` | One tracker's state and all its configuration parameters |
| `neyos history <alias> [--type point\|event] [--limit N]` | Latest points or events. `LAG` is the delay between measurement and reception, so a backlog sent after a coverage gap stands out |
| `neyos actions <alias> [--limit N]` | Commands queued or sent to a tracker |
| `neyos cancel <actionId>` | Cancel a waiting action |
| `neyos configs` | Configurations |
| `neyos audit <config>` | Trackers whose parameters differ from a configuration, with each difference |
| `neyos send-config <config> <alias>...` | Queue a configuration on trackers. Each beacon applies it on its next connection |
| `neyos endpoints` | Webhook endpoints, with IDs and last delivery |
| `neyos deliveries <endpointId> [--limit N] [--failed]` | Webhook delivery log: HTTP status, response time, tracker, element count |
| `neyos endpoint-add <url> --customer NAME [--description TEXT]` | Create an enabled webhook endpoint |
| `neyos endpoint-enable <endpointId>` | Enable an endpoint |
| `neyos endpoint-disable <endpointId>` | Disable an endpoint |

`<alias>` also accepts a tracker serial or ID, and `<config>` a configuration
name or ID. `neyos help` prints the same list.

Options:

- `--json` prints the raw API data instead of a table.
- `--yes` skips the confirmation prompt that every write command shows first.

Webhook URLs are shown with their `token=` query value masked. `--json` output
is not masked.

## Examples

```sh
# Which trackers are not running the configuration, and are they online?
neyos audit "My config"

# Push it to two of them
neyos send-config "My config" 0012 0017

# Did the webhook reject anything recently?
neyos deliveries end_xxxxxxxx --limit 500 --failed
```

## Notes

- `--failed` filters the deliveries fetched with `--limit`, not the whole log.
  The backoffice does not retry a failed delivery, so a rejected message is lost
  to the receiving server.
- `audit` ignores parameters a tracker has no recorded value for.

## Tests

```sh
npm test
```

## License

MIT
