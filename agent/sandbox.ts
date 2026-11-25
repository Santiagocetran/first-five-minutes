import { defineSandbox } from 'eve/sandbox';
import { defineSandboxProvider } from 'eve/sandbox/provider';

const Disabled = defineSandboxProvider({
  name: 'ffm-disabled',
  environment() {
    return {
      async prepare() { return {}; },
      async start() { throw new Error('The eve session has no sandbox'); },
      async resume() { throw new Error('The eve session has no sandbox'); },
      async onSessionEnd() {},
    };
  },
});
export const environment = Disabled.environment();
export default defineSandbox(() => environment.open());
