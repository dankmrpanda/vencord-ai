import './scope.test';
import './search.test';
import './agent.test';
import { runProviderTests } from './provider.test';

void runProviderTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
