import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateActivePeriods,
  calculateBridgeVolume,
  calculateTxCounts,
  calculateTwabUsd,
} from "@/lib/hevm/metrics";
import { createPriceContext } from "@/lib/hevm/pricing";
import { ClassifiedActivity, PortfolioSegment, RawActivity } from "@/lib/hevm/types";

test("TWAB simple example equals 350 USD", () => {
  const day = 24 * 60 * 60;
  const segments: PortfolioSegment[] = [
    {
      startTimestamp: 0,
      endTimestamp: 3 * day,
      durationSeconds: 3 * day,
      totalUsd: 100,
      contribution: 100 * 3 * day,
      positions: [],
      priceSources: [],
    },
    {
      startTimestamp: 3 * day,
      endTimestamp: 7 * day,
      durationSeconds: 4 * day,
      totalUsd: 500,
      contribution: 500 * 4 * day,
      positions: [],
      priceSources: [],
    },
    {
      startTimestamp: 7 * day,
      endTimestamp: 10 * day,
      durationSeconds: 3 * day,
      totalUsd: 400,
      contribution: 400 * 3 * day,
      positions: [],
      priceSources: [],
    },
  ];

  const result = calculateTwabUsd(segments);
  assert.equal(result.twabUsd, 350);
});

test("tx count breakdown tracks sent/received/erc20/internal/all", () => {
  const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const activities: RawActivity[] = [
    {
      txHash: "0x01",
      blockNumber: 1,
      timestamp: 1,
      from: wallet,
      to: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      type: "normal_tx",
    },
    {
      txHash: "0x02",
      blockNumber: 2,
      timestamp: 2,
      from: "0xcccccccccccccccccccccccccccccccccccccccc",
      to: wallet,
      type: "normal_tx",
    },
    {
      txHash: "0x03",
      blockNumber: 3,
      timestamp: 3,
      from: "0xcccccccccccccccccccccccccccccccccccccccc",
      to: wallet,
      type: "erc20_transfer",
      logIndex: 1,
    },
    {
      txHash: "0x04",
      blockNumber: 4,
      timestamp: 4,
      from: wallet,
      to: "0xdddddddddddddddddddddddddddddddddddddddd",
      type: "internal_transfer",
      traceId: "0_0",
    },
  ];

  const counts = calculateTxCounts(activities, wallet);
  assert.equal(counts.sentAccountTxCount, 1);
  assert.equal(counts.receivedAccountTxCount, 1);
  assert.equal(counts.erc20TransferCount, 1);
  assert.equal(counts.internalTxCount, 1);
  assert.equal(counts.allActivityTxCount, 4);
});

test("active periods count unique day and unique week", () => {
  const activities: RawActivity[] = [
    {
      txHash: "0x01",
      blockNumber: 1,
      timestamp: Date.UTC(2026, 0, 5, 10, 0, 0) / 1000,
      type: "normal_tx",
    },
    {
      txHash: "0x02",
      blockNumber: 2,
      timestamp: Date.UTC(2026, 0, 5, 18, 0, 0) / 1000,
      type: "erc20_transfer",
    },
    {
      txHash: "0x03",
      blockNumber: 3,
      timestamp: Date.UTC(2026, 0, 14, 10, 0, 0) / 1000,
      type: "internal_transfer",
    },
  ];

  const periods = calculateActivePeriods(activities);
  assert.equal(periods.activeDays, 2);
  assert.equal(periods.activeWeeks, 2);
});

test("bridge volume classifies Core->EVM and EVM->Core", async () => {
  const activities: ClassifiedActivity[] = [
    {
      txHash: "0x01",
      blockNumber: 1,
      timestamp: 1,
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: "0x2222222222222222222222222222222222222222",
      type: "bridge_event",
      protocolId: "bridge",
      protocolName: "Bridge",
      category: "bridge",
      confidence: 1,
      amount: 1,
    },
    {
      txHash: "0x02",
      blockNumber: 2,
      timestamp: 2,
      from: "0x2222222222222222222222222222222222222222",
      to: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      type: "bridge_event",
      protocolId: "bridge",
      protocolName: "Bridge",
      category: "bridge",
      confidence: 1,
      amount: 1,
    },
  ];

  const bridge = await calculateBridgeVolume(activities, async () => 100);
  assert.equal(bridge.evmToCoreVolumeUsd, 100);
  assert.equal(bridge.coreToEvmVolumeUsd, 100);
  assert.equal(bridge.totalBridgeVolumeUsd, 200);
});

test("unknown token price is ignored and does not crash", async () => {
  const { context, ignoredTokens } = await createPriceContext();
  const price = await context.resolvePriceUsd("SOME_UNKNOWN_TOKEN_123456", Math.floor(Date.now() / 1000));
  assert.equal(price.source, "missing");
  assert.equal(ignoredTokens.length > 0, true);
});

