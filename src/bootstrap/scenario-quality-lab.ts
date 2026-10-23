import type { LocalQualityFixtureLoader, LocalQualityFixtureV1 } from '../acceptance/local-quality.js';
import {
  SCENARIO_WINDOW_DATASET_DIGEST,
  listScenarioWindowFixtureIds,
  loadScenarioWindowFixture,
} from '../infrastructure/simulator/scenario-window-fixtures.js';
import { startScenarioWindowServer } from '../infrastructure/simulator/scenario-window-server.js';

/** Deterministic in-process loader; no sockets and no clock dependence. */
export function createInProcessScenarioFixtureLoader(): LocalQualityFixtureLoader {
  return (fixtureId) => loadScenarioWindowFixture(fixtureId);
}

export interface ScenarioQualityLabOptions {
  port?: number;
  fetchImpl?: typeof fetch;
}

export interface ScenarioQualityLab {
  readonly url: string;
  readonly datasetDigest: string;
  readonly fixtureIds: readonly string[];
  /** Synchronous loader backed by fixtures already fetched over loopback. */
  createFixtureLoader(): LocalQualityFixtureLoader;
  close(): Promise<void>;
}

/**
 * Loopback fixture lab for the offline quality set. It serves the same frozen
 * dataset as the in-process loader, so a run can prove the simulator transport
 * while staying strictly local. Fixtures are fetched once at start; the lab keeps
 * its own cache instance and never writes to module-level state.
 */
export async function startScenarioQualityLab(options: ScenarioQualityLabOptions = {}): Promise<ScenarioQualityLab> {
  const server = await startScenarioWindowServer(options.port === undefined ? {} : { port: options.port });
  const fetchImpl = options.fetchImpl ?? fetch;
  const cache = new Map<string, LocalQualityFixtureV1>();
  try {
    for (const fixtureId of listScenarioWindowFixtureIds()) {
      cache.set(fixtureId, await fetchFixture(fetchImpl, server.url, fixtureId));
    }
  } catch (error) {
    await server.close();
    throw error;
  }
  let closed = false;
  return {
    url: server.url,
    datasetDigest: SCENARIO_WINDOW_DATASET_DIGEST,
    fixtureIds: listScenarioWindowFixtureIds(),
    createFixtureLoader: () => (fixtureId) => {
      const fixture = cache.get(fixtureId);
      if (fixture === undefined) throw new Error('SCENARIO_FIXTURE_NOT_LOADED');
      return fixture;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      cache.clear();
      await server.close();
    },
  };
}

async function fetchFixture(
  fetchImpl: typeof fetch,
  baseUrl: string,
  fixtureId: string,
): Promise<LocalQualityFixtureV1> {
  const response = await fetchImpl(`${baseUrl}/api/v1/scenarios/${encodeURIComponent(fixtureId)}/window`);
  if (!response.ok) throw new Error(`SCENARIO_FIXTURE_HTTP_${response.status}`);
  const body = await response.json() as { status?: string; fixture?: LocalQualityFixtureV1 };
  if (body.status !== 'success' || body.fixture === undefined || body.fixture.fixtureId !== fixtureId) {
    throw new Error('SCENARIO_FIXTURE_PAYLOAD_INVALID');
  }
  return body.fixture;
}
