/** Import every module UI once so registrations run before a game renders. */
import './five-six';
import './knights';
import './seafaring';

export { registerUiModule, uiModule, uiModulesFor } from './registry';
export type { ModuleDialogProps, ModuleHudProps, ModulePanelProps, UiModule } from './registry';
