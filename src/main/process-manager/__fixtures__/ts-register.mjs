// Lets plain Node, with its built-in type stripping, run parent.ts:
//   node --import ./ts-register.mjs parent.ts
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);
