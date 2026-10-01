// Cross-host check-ins: the inbox and run logs are per-host, so a check-in
// must execute on the host where the task lives — `ia checkin <n> --host …`
// SSHes there and runs the same command remotely. These tests cover the
// pure pieces: shell quoting (including hostile quotes in the question) and
// the remote command construction.

import test from "node:test";
import assert from "node:assert/strict";
import { shq, checkinRemoteCommand } from "../lib/cli.js";

test("shq single-quotes safely", () => {
  assert.equal(shq("plain"), "'plain'");
  assert.equal(shq("it's"), "'it'\\''s'");
  assert.equal(shq("$(rm -rf /)"), "'$(rm -rf /)'"); // no interpolation
});

test("checkinRemoteCommand: default shape", () => {
  assert.equal(
    checkinRemoteCommand({ remoteRoot: "/home/bits/github/nibble", issue: 28, question: "", wait: 120 }),
    "cd '/home/bits/github/nibble' && ia checkin 28 --wait 120"
  );
});

test("checkinRemoteCommand: question is passed through, quoted", () => {
  const cmd = checkinRemoteCommand({ remoteRoot: "/r", issue: 5, question: "how's it going?", wait: 60 });
  assert.equal(cmd, "cd '/r' && ia checkin 5 'how'\\''s it going?' --wait 60");
});
