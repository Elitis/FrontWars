/**
 * @jest-environment jsdom
 */

// Mock 'jose' first to avoid ESM parsing issues when dependent modules import it.
jest.mock("jose", () => ({
  // Provide only the pieces referenced in code (e.g., base64url encode/decode)
  base64url: {
    encode: () => "",
    decode: () => new Uint8Array(),
  },
}));

// Mock 'nanoid' (ESM) to prevent Jest ESM parse errors.
jest.mock("nanoid", () => ({
  customAlphabet: () => () => "mockid",
  nanoid: () => "mockid",
}));

// Minimal mocks for ESM-only lit packages so importing client code doesn't break Jest CommonJS transforms.
jest.mock("lit", () => ({
  LitElement: class {},
  css: () => ({ cssText: "" }),
  html: () => "",
}));
jest.mock("lit/decorators.js", () => ({
  customElement: () => () => {},
  state: () => () => {},
  property: () => () => {}, // Needed by components like GoogleAdElement
}));

// Mock Main.ts to avoid executing heavy UI bootstrap & side-effect imports (e.g., GoogleAdElement)
jest.mock("../src/client/Main", () => ({
  getPersistentID: () => "persistent-id-test",
}));

// Directly mock GoogleAdElement in case something else loads it
jest.mock("../src/client/GoogleAdElement", () => ({}));

// Mock TerrainMapFileLoader to avoid importing version.txt
jest.mock("../src/client/TerrainMapFileLoader", () => ({
  terrainMapFileLoader: {},
}));

// Mock GameView to prevent pulling in deep dependencies.
jest.mock("../src/core/game/GameView", () => ({
  GameView: class {},
  PlayerView: class {},
}));

// Mock Transport (root cause chain importing jose). Provide only the pieces ClientGameRunner references.
jest.mock("../src/client/Transport", () => {
  class SendUpgradeStructureIntentEvent {
    constructor(public readonly unitId: number, public readonly unitType: any) {}
  }
  return {
    SendUpgradeStructureIntentEvent,
    SendHashEvent: class {},
    SendAttackIntentEvent: class {},
    SendBoatAttackIntentEvent: class {},
    SendSpawnIntentEvent: class {},
    Transport: class {
      public isLocal = true;
      joinGame() {}
      connect() {}
      leaveGame() {}
      turnComplete() {}
    },
  };
});

// Mock GameRenderer to avoid DOM querying.
jest.mock("../src/client/graphics/GameRenderer", () => ({
  createRenderer: () => ({
    initialize: jest.fn(),
    tick: jest.fn(),
    uiState: { attackRatio: 20 },
    transformHandler: {
      screenToWorldCoordinates: (x: number, y: number) => ({
        x: Math.floor(x / 10),
        y: Math.floor(y / 10),
      }),
    },
  }),
  GameRenderer: class {},
}));

import { EventBus } from "../src/core/EventBus";
import { AutoUpgradeEvent } from "../src/client/InputHandler";
import { ClientGameRunner } from "../src/client/ClientGameRunner";
import { UnitType } from "../src/core/game/Game";
import { SendUpgradeStructureIntentEvent } from "../src/client/Transport";

class MockPlayerView {
  constructor(private readonly _gold: bigint, private readonly _actions: any) {}
  gold() { return this._gold; }
  troops() { return 0; }
  actions(_: any) { return Promise.resolve(this._actions); }
}

const mockRenderer: any = {
  uiState: { attackRatio: 1 },
  initialize: jest.fn(),
  tick: jest.fn(),
  transformHandler: {
    screenToWorldCoordinates: (x: number, y: number) => ({
      x: Math.floor(x / 10),
      y: Math.floor(y / 10),
    }),
  },
};

const makeGameView = (unitId: number, unitType: UnitType, unitLevel: number) => ({
  isValidCoord: () => true,
  ref: (x: number, y: number) => ({ x, y }),
  inSpawnPhase: () => false,
  manhattanDist: () => 0,
  units: () => [{
    id: () => unitId,
    level: () => unitLevel,
    tile: () => ({ x: 0, y: 0 }),
    owner: () => ({ id: () => 1, isPlayer: () => true }),
  }],
  playerByClientID: () => new MockPlayerView(0n, {}),
  owner: () => ({ id: () => 1, isPlayer: () => true }),
  setFocusedPlayer: jest.fn(),
  isLand: () => true,
  nearbyUnits: () => [],
  euclideanDistSquared: () => 0,
} as any);

const buildActions = (unitId: number, cost: bigint, type: UnitType) => ({
  canAttack: false,
  buildableUnits: [{ canUpgrade: unitId, cost, type }],
});

describe("ClientGameRunner autoUpgradeEvent", () => {
  const lobby: any = {
    clientID: 1,
    gameID: 1,
    playerName: "p",
    serverConfig: {},
    gameStartInfo: { config: { difficulty: 0, gameMap: "" }, gameID: 1, players: [] },
    flag: "f",
    pattern: undefined,
    token: "tkn",
  };
  const transport: any = { joinGame: jest.fn(), connect: jest.fn(), leaveGame: jest.fn(), turnComplete: jest.fn(), isLocal: true, reconnect: jest.fn() };
  const worker: any = { start: jest.fn(), sendTurn: jest.fn(), cleanup: jest.fn(), sendHeartbeat: jest.fn() };
  const input: any = { initialize: jest.fn() };

  test("shift middle click (levels=10) with enough gold emits 10 upgrade intents", async () => {
    const eventBus = new EventBus();
    const unitId = 42;
    const costPerLevel = 10n;
    const gold = 200n; // sufficient for >10
    const actions = buildActions(unitId, costPerLevel, UnitType.City);
    const gameView = makeGameView(unitId, UnitType.City, 1);
    gameView.playerByClientID = () => new MockPlayerView(gold, actions);

    const emitted: SendUpgradeStructureIntentEvent[] = [];
    eventBus.on(SendUpgradeStructureIntentEvent, (e) => emitted.push(e));

    const runner = new ClientGameRunner(lobby, eventBus, mockRenderer, input, transport, worker, gameView);
    runner.start();

    eventBus.emit(new AutoUpgradeEvent(50, 50, 10));
    await new Promise((r) => setTimeout(r, 0));

    expect(emitted).toHaveLength(10);
    emitted.forEach((e) => expect(e.unitId).toBe(unitId));
  });

  test("shift middle click (levels=10) with gold for only 7 emits 7 upgrade intents", async () => {
    const eventBus = new EventBus();
    const unitId = 77;
    const costPerLevel = 10n;
    const gold = 70n; // only 7 affordable
    const actions = buildActions(unitId, costPerLevel, UnitType.City);
    const gameView = makeGameView(unitId, UnitType.City, 2);
    gameView.playerByClientID = () => new MockPlayerView(gold, actions);

    const emitted: SendUpgradeStructureIntentEvent[] = [];
    eventBus.on(SendUpgradeStructureIntentEvent, (e) => emitted.push(e));

    const runner = new ClientGameRunner(lobby, eventBus, mockRenderer, input, transport, worker, gameView);
    runner.start();

    eventBus.emit(new AutoUpgradeEvent(100, 100, 10));
    await new Promise((r) => setTimeout(r, 0));

    expect(emitted).toHaveLength(7);
    emitted.forEach((e) => expect(e.unitId).toBe(unitId));
  });

  test("fallback: requesting 10 with insufficient gold for even 1 still emits 1 attempt", async () => {
    const eventBus = new EventBus();
    const unitId = 5;
    const costPerLevel = 10n;
    const gold = 5n; // cannot afford a single level => fallback path
    const actions = buildActions(unitId, costPerLevel, UnitType.City);
    const gameView = makeGameView(unitId, UnitType.City, 1);
    gameView.playerByClientID = () => new MockPlayerView(gold, actions);

    const emitted: SendUpgradeStructureIntentEvent[] = [];
    eventBus.on(SendUpgradeStructureIntentEvent, (e) => emitted.push(e));

    const runner = new ClientGameRunner(lobby, eventBus, mockRenderer, input, transport, worker, gameView);
    runner.start();

    eventBus.emit(new AutoUpgradeEvent(25, 25, 10));
    await new Promise((r) => setTimeout(r, 0));

    expect(emitted).toHaveLength(1);
    expect(emitted[0].unitId).toBe(unitId);
  });
});
