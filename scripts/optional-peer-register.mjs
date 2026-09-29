// A separate file because module.register loads its hooks off-thread, from their own module.
import {register} from 'node:module';

register('./optional-peer-hooks.mjs', import.meta.url);
