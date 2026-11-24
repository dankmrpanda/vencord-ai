import './scope.test';
import './mentionMatching.test';
import './search.test';
import './agent.test';
import { runBugHuntTests } from './bugHunt.test';
import { runChatHistoryTests } from './chatHistory.test';
import { runChatServiceTests } from './chatService.test';
import { runCompressionTests } from './compression.test';
import { runGuardrailsTests } from './guardrails.test';
import { runHuntAgentTests } from './huntAgent.test';
import { runHuntLifecycleTests } from './huntLifecycle.test';
import { runHuntScopeTests } from './huntScope.test';
import { runHuntSearchTests } from './huntSearch.test';
import { runHuntUiTests } from './huntUi.test';
import { runMessageLaunchTests } from './messageLaunch.test';
import { runModelLifecycleTests } from './modelLifecycle.test';
import { runModelSettingsTests } from './modelSettings.test';
import { runProviderTests } from './provider.test';
import { runQualityImprovementTests } from './qualityImprovements.test';
import { runRegressionFixTests } from './regressionFixes.test';
import { runRuntimeLifecycleTests } from './runtimeLifecycle.test';
import { runScopePermissionTests } from './scopePermission.test';
import { runSearchPipelineTests } from './searchPipeline.test';

async function runAllSuites(): Promise<void> {
  await runGuardrailsTests();
  await runCompressionTests();
  await runProviderTests();
  await runRegressionFixTests();
  await runMessageLaunchTests();
  await runModelLifecycleTests();
  await runModelSettingsTests();
  await runRuntimeLifecycleTests();
  await runSearchPipelineTests();
  await runBugHuntTests();
  await runScopePermissionTests();
  await runHuntScopeTests();
  await runHuntLifecycleTests();
  await runChatHistoryTests();
  await runHuntAgentTests();
  await runHuntSearchTests();
  await runHuntUiTests();
  await runQualityImprovementTests();
  await runChatServiceTests();
}

void runAllSuites().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
