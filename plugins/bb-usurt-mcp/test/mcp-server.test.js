import assert from "node:assert/strict";
import test from "node:test";
import { AccountManager } from "../src/account-manager.js";

test("AccountManager correctly handles empty accounts and error paths", () => {
  const manager = new AccountManager({ accounts: [] });
  assert.equal(manager.size, 0);
  assert.equal(manager.getActiveAccount(), null);

  const summary = manager.listAccountsSummary();
  assert.equal(summary.totalAccounts, 0);
  assert.equal(summary.activeAccount, null);

  assert.throws(() => manager.getClient("not_existing"), /не найден/);
  assert.throws(() => manager.setActiveAccount("not_existing"), /не найден/);
  manager.close();
});

test("AccountManager comparison handles empty assignment lists", async () => {
  const manager = new AccountManager();
  const mockClient1 = {
    username: "u1",
    authenticated: true,
    async ensureAuthenticated() {},
    async listAssignments() { return { assignments: [], warnings: [] }; },
    close() {},
  };
  const mockClient2 = {
    username: "u2",
    authenticated: true,
    async ensureAuthenticated() {},
    async listAssignments() { return { assignments: [], warnings: [] }; },
    close() {},
  };

  manager.addAccount({ id: "acc1", client: mockClient1 });
  manager.addAccount({ id: "acc2", client: mockClient2 });

  const res = await manager.compareSubmissions({ account1: "acc1", account2: "acc2" });
  assert.equal(res.needsSubmissionByAccount1.length, 0);
  assert.equal(res.needsSubmissionByAccount2.length, 0);
  assert.equal(res.bothSubmitted.length, 0);
  assert.equal(res.neitherSubmitted.length, 0);

  manager.close();
});
