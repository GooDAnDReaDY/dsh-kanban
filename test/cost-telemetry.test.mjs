import test from "node:test";
import assert from "node:assert/strict";
import {
  isCostMeterAvailable,
  extractSessionUsage,
  calculateTokenCost,
  checkCostLimit,
} from "../lib/cost-telemetry.js";

test("isCostMeterAvailable: корректное обнаружение плагина и защита от сбоев (#374)", () => {
  assert.equal(isCostMeterAvailable(null), false);
  assert.equal(isCostMeterAvailable({}), false);

  // ctx.costMeter
  assert.equal(isCostMeterAvailable({ costMeter: {} }), true);

  // ctx.get('costMeter')
  assert.equal(isCostMeterAvailable({ get: (k) => (k === 'costMeter' ? {} : null) }), true);

  // ctx.settings.describe
  assert.equal(isCostMeterAvailable({
    settings: {
      describe: () => [{ ns: 'dsh-kanban' }, { ns: 'dsh-cost-meter' }],
    },
  }), true);

  // ctx.registry Map
  const regMap = new Map();
  regMap.set('@goodandready/dsh-cost-meter', {});
  assert.equal(isCostMeterAvailable({ registry: regMap }), true);

  // Падающий get не роняет выполнение
  assert.equal(isCostMeterAvailable({
    get: () => { throw new Error("cordis internal error"); },
  }), false);
});

test("extractSessionUsage: агрегация токенов из проекций моделей и ходов (#374)", () => {
  // Пустой или невалидный объект
  const empty = extractSessionUsage(null);
  assert.equal(empty.totalTokens, 0);
  assert.equal(empty.models.length, 0);

  // Проекция с несколькими моделями и слотами
  const projection = {
    models: [
      {
        provider: "deepseek",
        model: "deepseek-chat",
        slots: {
          slot1: {
            uncachedInputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 200,
            cacheWriteTokens: 100,
          },
          slot2: {
            uncachedInputTokens: 500,
            outputTokens: 250,
            cacheReadTokens: 100,
            cacheWriteTokens: 50,
          },
        },
      },
      {
        provider: "openai",
        model: "gpt-4o",
        slots: {
          slot1: {
            uncachedInputTokens: 200,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      },
    ],
    turns: [{}, {}],
  };

  const usage = extractSessionUsage(projection);
  assert.equal(usage.uncachedInputTokens, 1700);
  assert.equal(usage.outputTokens, 850);
  assert.equal(usage.cacheReadTokens, 300);
  assert.equal(usage.cacheWriteTokens, 150);
  assert.equal(usage.totalTokens, 3000);
  assert.equal(usage.turnsCount, 2);
  assert.deepEqual(usage.models, ["deepseek/deepseek-chat", "openai/gpt-4o"]);
});

test("calculateTokenCost: расчет стоимости по тарифам и валютам (#374)", () => {
  // Нулевое использование
  const zero = calculateTokenCost({ usage: null });
  assert.equal(zero.costUsd, 0);
  assert.equal(zero.costFormatted, "$0.00");

  // Стандартный тариф DeepSeek:
  // 1,000,000 uncached input = $0.14
  // 1,000,000 output = $0.28
  // 1,000,000 cache read = $0.014
  const usage = {
    uncachedInputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 0,
  };

  const standard = calculateTokenCost({ usage });
  // 0.14 + 0.28 + 0.014 = 0.434 -> round to 0.434
  assert.equal(standard.costUsd, 0.434);
  assert.equal(standard.costFormatted, "$0.43");

  // Кастомный тариф и курс валюты
  const custom = calculateTokenCost({
    usage: { uncachedInputTokens: 100_000, outputTokens: 50_000 },
    schedule: { input: 1.0, output: 2.0 }, // $1 per 1M input, $2 per 1M output
    usdRate: 90,
    currency: "₽",
  });
  // (100000*1 + 50000*2)/1000000 = 0.20 USD -> 0.20 * 90 = 18.00 RUB
  assert.equal(custom.costUsd, 0.2);
  assert.equal(custom.costFormatted, "₽18.00");
  assert.equal(custom.currency, "₽");
});

test("checkCostLimit: проверка лимита бюджета (#374)", () => {
  // Лимит отключен (0)
  assert.equal(checkCostLimit({ costUsd: 5.5, limit: 0 }).exceeded, false);

  // Лимит не превышен
  assert.equal(checkCostLimit({ costUsd: 0.8, limit: 1.0 }).exceeded, false);

  // Лимит превышен
  assert.equal(checkCostLimit({ costUsd: 1.05, limit: 1.0 }).exceeded, true);
  assert.equal(checkCostLimit({ costUsd: 1.0, limit: 1.0 }).exceeded, true);
});
