// The registration half of docs/adding-a-tool.md, kept in its own file so the import is a real one.
import {ToolRegistry} from '../src/index.js';

const toolRegistry = new ToolRegistry();

// #region register
import {weatherTool, executeWeather} from './weather-tool.js';

// ... existing registrations ...

toolRegistry.register(weatherTool, executeWeather);
// #endregion

void toolRegistry;
