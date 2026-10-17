// Neyos backoffice from the terminal. Talks to the API behind
// platform.neyos-equipment.com with the token `neyos login` saves (or
// NEYOS_TOKEN), so it can do whatever that account can do in the web UI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";

const API = "https://api.neyos-equipment.com";
const TOKEN_FILE = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "neyos",
    "token.json"
);

const HELP = `neyos: Neyos backoffice from the terminal

  login                          sign in with email + password (token saved to ${TOKEN_FILE})
  logout                         revoke the saved token
  whoami

  trackers                       online, battery, last point, config, pending actions
  tracker <alias>                one tracker's state and configuration parameters
  history <alias> [--type point|event] [--limit N]
                                 latest points/events; LAG = received minus measured (catch-up)
  actions <alias> [--limit N]    commands queued or sent to a tracker
  cancel <actionId>              cancel a waiting action

  configs                        configurations
  audit <config>                 trackers whose parameters differ from a configuration
  send-config <config> <alias>...
                                 queue a configuration; each beacon applies it on its next connection

  endpoints                      webhook endpoints
  deliveries <endpointId> [--limit N] [--failed]
                                 webhook delivery log (Neyos never retries a failed one)
  endpoint-add <url> --customer NAME [--description TEXT]
  endpoint-enable <endpointId>
  endpoint-disable <endpointId>

  --json   raw API data        --yes   skip the confirmation on writes
  <alias> also takes a serial or tracker id, <config> a name or id.
  NEYOS_TOKEN overrides the saved token.`;

class CliError extends Error {}
const fail = (message) => {
    throw new CliError(message);
};
const need = (value, usage) => value ?? fail(`Usage: neyos ${usage}`);

function readToken() {
    if (process.env.NEYOS_TOKEN) return process.env.NEYOS_TOKEN;
    try {
        return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")).value;
    } catch {
        return fail("Not signed in: run `neyos login`.");
    }
}

async function api(route, { method = "GET", body } = {}) {
    const res = await fetch(API + route, {
        method,
        headers: {
            Authorization: `Bearer ${readToken()}`,
            ...(body && { "Content-Type": "application/json" })
        },
        body: body && JSON.stringify(body)
    });
    const json = await res.json().catch(() => null);
    if (res.status === 401) fail("Session expired or not signed in: run `neyos login`.");
    if (!res.ok) {
        const why = json?.errors?.map((e) => e.message).join("; ") ?? "";
        fail(`${method} ${route}: HTTP ${res.status} ${why}`.trim());
    }
    return json;
}

// Every page of a paginated list ({ meta, data }).
async function all(route) {
    const items = [];
    for (let page = 1; ; page++) {
        const sep = route.includes("?") ? "&" : "?";
        const { data, meta } = await api(`${route}${sep}page=${page}&perPage=100`);
        items.push(...data);
        if (!meta || page >= meta.lastPage) return items;
    }
}

async function mapInBatches(items, size, fn) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
    }
    return out;
}

const listTrackers = () => all("/trackers?sort=alias&order=asc");
const listConfigs = () => all("/configurations?sort=name&order=asc");
const listEndpoints = () => all("/endpoints?sort=url&order=asc"); // the default sort 500s

export const findTracker = (trackers, ref) =>
    trackers.find((t) => [t.alias, t.serial, t.id].map(String).includes(String(ref))) ??
    fail(`No tracker "${ref}".`);

async function findConfig(ref) {
    const config = (await listConfigs()).find(
        (c) => c.id === ref || c.name.toLowerCase() === ref.toLowerCase()
    );
    if (!config) fail(`No configuration "${ref}".`);
    return api(`/configurations/${config.id}`); // the list omits the parameters
}

// The device command a parameter drives, as Neyos names it: "gnss R" (GPS
// interval), "modem RL" (live send interval), "alert B1 ES"...
export const paramLabel = (p) => [p.command, p.subCommand, p.code].filter(Boolean).join(" ");

// Parameters whose last known value on the tracker differs from the
// configuration. A parameter the tracker has no recorded value for is
// skipped: there is nothing to compare it with.
export function configDiff(configParams, trackerParams) {
    const current = new Map(trackerParams.map((p) => [p.configParameterId, p.value]));
    return configParams
        .filter((p) => current.has(p.configParameterId))
        .filter((p) => String(current.get(p.configParameterId)) !== String(p.value))
        .map((p) => ({
            param: paramLabel(p.configParameter),
            from: current.get(p.configParameterId),
            to: p.value
        }));
}

// A webhook URL often carries a shared secret (?token=): keep it off the screen.
export const maskToken = (url) => String(url).replace(/([?&]token=)[^&]+/, "$1***");

export function table(rows) {
    const cells = rows.map((r) => r.map((c) => String(c ?? "")));
    const widths = cells[0].map((_, i) => Math.max(...cells.map((r) => r[i].length)));
    return cells.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

export function ago(ts, now = Date.now()) {
    if (!ts) return "never";
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 120) return `${s}s`;
    if (s < 7200) return `${Math.round(s / 60)}m`;
    if (s < 172800) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

const utc = (ts) => (ts ? new Date(ts).toISOString().slice(0, 19).replace("T", " ") + "Z" : "");
const battery = (t) => (t.battery == null ? "?" : `${t.battery}%${t.charging ? " (charging)" : ""}`);
const pending = (t) => (t.waitingActions ?? []).map((a) => a.type).join(", ");
const limit = (o) => Number(o.limit) || 20;
const print = (o, data, render) => console.log(o.json ? JSON.stringify(data, null, 2) : render());

async function confirm(question, yes) {
    if (yes) return;
    if (!process.stdin.isTTY) fail("No terminal to confirm in: pass --yes.");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`${question} [y/N] `);
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) fail("Aborted.");
}

function askHidden(question) {
    process.stdout.write(question);
    return new Promise((resolve, reject) => {
        let value = "";
        const done = () => {
            process.stdin.off("data", onData);
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdout.write("\n");
        };
        const onData = (chunk) => {
            for (const ch of chunk) {
                if (ch === "\r" || ch === "\n") return done(), resolve(value);
                if (ch === "\u0003") return done(), reject(new CliError("Aborted."));
                value = ch === "\u007f" || ch === "\b" ? value.slice(0, -1) : value + ch;
            }
        };
        process.stdin.setRawMode(true);
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", onData);
        process.stdin.resume();
    });
}

async function setEndpoint([id], o, enabled) {
    need(id, `endpoint-${enabled ? "enable" : "disable"} <endpointId>`);
    const ep = (await listEndpoints()).find((e) => e.id === id) ?? fail(`No endpoint ${id}.`);
    const verb = enabled ? "Enable" : "Disable";
    await confirm(`${verb} "${ep.description ?? ep.id}" (${maskToken(ep.url)})?`, o.yes);
    await api(`/endpoints/${id}`, {
        method: "PUT",
        body: { url: ep.url, description: ep.description, enabled, customerId: ep.customerId }
    });
    console.log(`${verb}d ${id}.`);
}

const commands = {
    async login() {
        if (!process.stdin.isTTY) fail("neyos login needs a terminal.");
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const email = (await rl.question("Email: ")).trim();
        rl.close();
        const password = await askHidden("Password: ");
        const res = await fetch(`${API}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password })
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) fail(json?.errors?.[0]?.message ?? `Login failed: HTTP ${res.status}`);
        fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
        fs.writeFileSync(TOKEN_FILE, JSON.stringify({ email, value: json.token.value }), { mode: 0o600 });
        console.log(`Signed in as ${json.user.email}.`);
    },

    async logout() {
        await api("/auth/logout", { method: "DELETE" }).catch(() => {});
        fs.rmSync(TOKEN_FILE, { force: true });
        console.log("Signed out.");
    },

    async whoami(_, o) {
        const { user } = await api("/auth/me");
        print(o, user, () => `${user.firstname} ${user.lastname} <${user.email}>`);
    },

    async trackers(_, o) {
        const trackers = await listTrackers();
        print(o, trackers, () =>
            table([
                ["ALIAS", "SERIAL", "ONLINE", "BATTERY", "LAST POINT", "NETWORK", "CONFIG", "PENDING"],
                ...trackers.map((t) => [
                    t.alias,
                    t.serial,
                    t.connected ? "yes" : "no",
                    battery(t),
                    ago(t.lastPointAt),
                    t.network,
                    t.configuration?.name ?? "-",
                    pending(t)
                ])
            ])
        );
    },

    async tracker([ref], o) {
        const t = findTracker(await listTrackers(), need(ref, "tracker <alias>"));
        const params = (await all(`/trackers/${t.id}/config-parameters`)).sort((a, b) =>
            paramLabel(a.configParameter).localeCompare(paramLabel(b.configParameter))
        );
        print(o, { ...t, configParameters: params }, () =>
            [
                table([
                    ["alias", t.alias],
                    ["serial", t.serial],
                    ["id", t.id],
                    ["customer", t.customer?.name],
                    ["online", t.connected ? "yes" : "no"],
                    ["battery", battery(t)],
                    ["temperature", t.temperature],
                    ["network", [t.network, t.networkOperator?.operator, t.rsrq && `rsrq ${t.rsrq}`].filter(Boolean).join(", ")],
                    ["last point", t.lastPointAt && `${utc(t.lastPointAt)} (${ago(t.lastPointAt)} ago)`],
                    ["position", t.latitude != null ? `${t.latitude}, ${t.longitude}` : ""],
                    ["firmware", t.versionSoftware],
                    ["config", t.configuration?.name ?? "-"],
                    ["pending", pending(t)]
                ]),
                "",
                table([
                    ["PARAMETER", "VALUE", "NAME"],
                    ...params.map((p) => [paramLabel(p.configParameter), p.value, p.configParameter.name])
                ])
            ].join("\n")
        );
    },

    async history([ref], o) {
        const t = findTracker(await listTrackers(), need(ref, "history <alias>"));
        const type = o.type ? `&type=${encodeURIComponent(o.type)}` : "";
        const { data } = await api(
            `/trackers/${t.id}/elements?paginated=true&page=1&perPage=${limit(o)}&sort=createdAt&order=desc${type}`
        );
        print(o, data, () =>
            table([
                ["MEASURED (UTC)", "LAG", "TYPE", "SOURCE", "LAT, LON", "ACCURACY", "SPEED", "BUFFER"],
                ...data.map(({ datas: d = {}, receivedAt }) => [
                    utc(d.timestamp),
                    d.timestamp && receivedAt ? ago(d.timestamp, receivedAt) : "",
                    d.eventType ?? d.type,
                    d.source,
                    d.latitude != null ? `${d.latitude}, ${d.longitude}` : "",
                    d.accuracy,
                    d.speed,
                    d.tags?.buffer
                ])
            ])
        );
    },

    async actions([ref], o) {
        const t = findTracker(await listTrackers(), need(ref, "actions <alias>"));
        const { data } = await api(
            `/trackers/${t.id}/actions?page=1&perPage=${limit(o)}&sort=createdAt&order=desc`
        );
        print(o, data, () =>
            table([
                ["ID", "TYPE", "STATUS", "CREATED (UTC)", "UPDATED (UTC)", "ATTEMPTS"],
                ...data.map((a) => [a.id, a.type, a.status, utc(a.createdAt), utc(a.updatedAt), a.attempts?.length ?? 0])
            ])
        );
    },

    async cancel([id], o) {
        need(id, "cancel <actionId>");
        await confirm(`Cancel action ${id}?`, o.yes);
        await api(`/tracker-actions/${id}/cancel`, { method: "PUT" });
        console.log(`Cancelled ${id}.`);
    },

    async configs(_, o) {
        const configs = await listConfigs();
        print(o, configs, () =>
            table([
                ["ID", "NAME", "CUSTOMER", "DESCRIPTION"],
                ...configs.map((c) => [c.id, c.name, c.customer?.name, c.description])
            ])
        );
    },

    async audit([ref], o) {
        const config = await findConfig(need(ref, "audit <config>"));
        const trackers = (await listTrackers()).filter(
            (t) => !config.customerId || t.customerId === config.customerId
        );
        const audited = await mapInBatches(trackers, 8, async (t) => ({
            tracker: t,
            diff: configDiff(config.configurationConfigParameters, await all(`/trackers/${t.id}/config-parameters`))
        }));
        const off = audited.filter((a) => a.diff.length);
        print(o, off.map((a) => ({ alias: a.tracker.alias, id: a.tracker.id, diff: a.diff, pending: pending(a.tracker) })), () =>
            off.length === 0
                ? `All ${trackers.length} trackers match "${config.name}".`
                : table([
                    ["ALIAS", "ONLINE", "PENDING", "DIFFERS (current -> config)"],
                    ...off.map(({ tracker: t, diff }) => [
                        t.alias,
                        t.connected ? "yes" : "no",
                        pending(t),
                        diff.map((d) => `${d.param} ${d.from} -> ${d.to}`).join(", ")
                    ])
                ]) + `\n\n${off.length} of ${trackers.length} trackers differ from "${config.name}".`
        );
    },

    async "send-config"([ref, ...aliases], o) {
        if (!ref || aliases.length === 0) fail("Usage: neyos send-config <config> <alias>...");
        const config = await findConfig(ref);
        const trackers = await listTrackers();
        const targets = aliases.map((a) => findTracker(trackers, a));
        await confirm(
            `Queue "${config.name}" on ${targets.map((t) => t.alias).join(", ")}? ` +
                "It changes how the beacons track, from their next connection.",
            o.yes
        );
        const res = await api("/tracker-actions/_bulk", {
            method: "POST",
            body: {
                trackerActions: targets.map((t) => ({
                    trackerId: t.id,
                    type: "send_config",
                    configurationId: config.id
                }))
            }
        });
        print(o, res, () => `Queued "${config.name}" on ${targets.length} tracker(s). Check with: neyos actions <alias>`);
    },

    async endpoints(_, o) {
        const endpoints = await listEndpoints();
        print(o, endpoints, () =>
            table([
                ["ID", "ENABLED", "LAST SENT", "CUSTOMER", "DESCRIPTION", "URL"],
                ...endpoints.map((e) => [
                    e.id,
                    e.enabled ? "yes" : "no",
                    e.sentAt ? `${ago(e.sentAt)} ago` : "never",
                    e.customer?.name,
                    e.description,
                    maskToken(e.url)
                ])
            ])
        );
    },

    async deliveries([id], o) {
        need(id, "deliveries <endpointId>");
        const { data } = await api(
            `/endpoints/${id}/conversations?page=1&perPage=${limit(o)}&sort=createdAt&order=desc`
        );
        // --failed filters the fetched page only: widen it with --limit.
        const rows = o.failed ? data.filter((c) => !(c.httpStatus >= 200 && c.httpStatus < 300)) : data;
        if (o.failed && !o.json && rows.length === 0) {
            return console.log(`No failed deliveries in the last ${data.length}.`);
        }
        print(o, rows, () =>
            table([
                ["SENT (UTC)", "HTTP", "MS", "TYPE", "TRACKER", "ELEMENTS"],
                ...rows.map((c) => {
                    let body = c.requestBody;
                    try {
                        if (typeof body === "string") body = JSON.parse(body);
                    } catch {
                        body = null;
                    }
                    return [
                        utc(c.createdAt),
                        c.httpStatus ?? c.status,
                        c.responseTime == null ? "" : Math.round(c.responseTime),
                        body?.type,
                        body?.data?.tracker?.alias,
                        body?.data?.elements?.length
                    ];
                })
            ])
        );
    },

    async "endpoint-add"([url], o) {
        need(url, "endpoint-add <url> --customer NAME [--description TEXT]");
        need(o.customer, "endpoint-add <url> --customer NAME [--description TEXT]");
        const customer =
            (await all("/customers?sort=name&order=asc")).find(
                (c) => c.name.toLowerCase() === o.customer.toLowerCase()
            ) ?? fail(`No customer "${o.customer}".`);
        await confirm(
            `Create an enabled endpoint for ${customer.name} -> ${maskToken(url)}? ` +
                "Neyos starts posting every message to it at once.",
            o.yes
        );
        const res = await api("/endpoints", {
            method: "POST",
            body: { url, description: o.description ?? null, enabled: true, customerId: customer.id }
        });
        print(o, res, () => `Created ${(res?.data ?? res)?.id ?? "the endpoint"}.`);
    },

    "endpoint-enable": (args, o) => setEndpoint(args, o, true),
    "endpoint-disable": (args, o) => setEndpoint(args, o, false)
};

export async function main(argv) {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                json: { type: "boolean" },
                yes: { type: "boolean", short: "y" },
                limit: { type: "string" },
                type: { type: "string" },
                failed: { type: "boolean" },
                customer: { type: "string" },
                description: { type: "string" },
                help: { type: "boolean", short: "h" }
            }
        });
    } catch (err) {
        console.error(`${err.message}\nRun: neyos help`);
        process.exitCode = 1;
        return;
    }
    const { values: o, positionals: [cmd, ...args] } = parsed;
    const run = Object.hasOwn(commands, cmd ?? "") && commands[cmd];
    if (!run || o.help) {
        console.log(HELP);
        if (cmd && cmd !== "help" && !run) process.exitCode = 1;
        return;
    }
    try {
        await run(args, o);
    } catch (err) {
        if (!(err instanceof CliError)) throw err;
        console.error(err.message);
        process.exitCode = 1;
    }
}
