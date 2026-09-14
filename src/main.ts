import { createApp } from './app';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp({ config });
  try {
    await app.listen(config.port, config.host);
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Application startup failed');
  process.exitCode = 1;
});
