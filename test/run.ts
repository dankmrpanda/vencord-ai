import './scope.test';
import './search.test';
import './agent.test';
import './challenger2_empirical';
import './challenger2_deletion_edgecases';
import { runIndexerUnitAndPropertyTests } from './indexer.test';
import { runProviderTests } from './provider.test';
import { runSearchPipelineTests } from './searchPipeline.test';
import { run100kRetrievalBenchmark } from './retrievalBenchmark';
import { runIndexStorageTests } from './indexStorage.test';
import { runMilestone1ChallengerTests } from './challenger_m1.test';
import { runMilestone2ChallengerTests as runM2Challenger1Tests } from './challenger_m2.test';
import { runMilestone2ChallengerTests as runM2Challenger2Tests } from './challenger_m2_empirical';
import { runRetrievalUnitAndIntegrationTests } from './retrieval.test';
import { runRerankerAndBudgetTests } from './reranker.test';
import { runMilestone3AdversarialTests } from './challenger_m3_adversarial';
import { runMilestone3ChallengerTests } from './challenger_m3_empirical';
import { runMilestone3Challenger2Tests } from './challenger_m3_2_empirical';
import { runGuardrailsTests } from './guardrails.test';
import { runMilestone4AdversarialTests } from './challenger_m4_adversarial';
import { runMilestone4StressTests } from './challenger_m4_2_stress';
import { runChatServiceTests } from './chatService.test';

// Run synchronous unit and property tests
runGuardrailsTests();
runIndexerUnitAndPropertyTests();
runRerankerAndBudgetTests();
runMilestone3AdversarialTests();
runMilestone3ChallengerTests();

async function runAsyncFixtures(): Promise<void> {
  await runMilestone4AdversarialTests();
  await runMilestone4StressTests();
  await runProviderTests();
  await runSearchPipelineTests();
  await runIndexStorageTests();
  await runMilestone1ChallengerTests();
  await runM2Challenger1Tests();
  await runM2Challenger2Tests();
  await runRetrievalUnitAndIntegrationTests();
  await runMilestone3Challenger2Tests();
  await runChatServiceTests();
  await run100kRetrievalBenchmark();
}

void runAsyncFixtures().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
