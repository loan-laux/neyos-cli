import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ago, configDiff, findTracker, maskToken, paramLabel, table } from "./neyos.js";

const gnss = { command: "gnss", code: "R" };
const modem = { command: "modem", code: "RL" };
const ledCharge = { command: "led", subCommand: "charge", code: "MC" };

describe("configDiff", () => {
    const config = [
        { configParameterId: "gnss", value: "30000", configParameter: gnss },
        { configParameterId: "modem", value: "30000", configParameter: modem },
        { configParameterId: "led", value: "3", configParameter: ledCharge }
    ];

    it("lists every parameter whose value differs, as current -> config", () => {
        const tracker = [
            { configParameterId: "gnss", value: "60000" },
            { configParameterId: "modem", value: "120000" }
        ];
        assert.deepEqual(configDiff(config, tracker), [
            { param: "gnss R", from: "60000", to: "30000" },
            { param: "modem RL", from: "120000", to: "30000" }
        ]);
    });

    it("ignores parameters the tracker has no record of, and numeric vs string values", () => {
        assert.deepEqual(configDiff(config, [{ configParameterId: "gnss", value: 30000 }]), []);
    });
});

describe("helpers", () => {
    it("labels a parameter with its device command", () => {
        assert.equal(paramLabel({ command: "alert", subCommand: "B1", code: "ES" }), "alert B1 ES");
        assert.equal(paramLabel(gnss), "gnss R");
    });

    it("masks the webhook secret in a URL", () => {
        assert.equal(
            maskToken("https://example.com/webhook?token=s3cret&a=1"),
            "https://example.com/webhook?token=***&a=1"
        );
    });

    it("finds a tracker by alias, serial or id", () => {
        const trackers = [{ id: "tra_1", alias: "0042", serial: 12345 }];
        assert.equal(findTracker(trackers, "0042").id, "tra_1");
        assert.equal(findTracker(trackers, "12345").id, "tra_1");
        assert.throws(() => findTracker(trackers, "0043"), { message: 'No tracker "0043".' });
    });

    it("formats ages and aligns tables", () => {
        const t = 1_792_000_000_000;
        assert.equal(ago(null), "never");
        assert.equal(ago(t, t + 90_000), "90s");
        assert.equal(ago(t, t + 3 * 3600_000), "3h");
        assert.equal(table([["A", "BB"], ["ccc", null]]), "A    BB\nccc");
    });
});
