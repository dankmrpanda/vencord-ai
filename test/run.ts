import './scope.test';
import './search.test';
import './agent.test';
import { runProviderTests } from './provider.test';
import { runSearchPipelineTests } from './searchPipeline.test';

async function runAsyncFixtures(): Promise<void> {
  await runProviderTests();
  await runSearchPipelineTests();
}

void runAsyncFixtures().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
