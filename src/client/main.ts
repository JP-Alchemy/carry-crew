import './style.css';
import { initPhysics } from '../shared/sim';
import { App } from './app';
import { platform } from './platform';

async function boot() {
  const loading = document.querySelector<HTMLElement>('#loading');
  try {
    await Promise.all([initPhysics(), platform.init()]);
    const app = new App(document.querySelector('#root')!);
    (window as unknown as { app: App }).app = app;
    await app.start();
    loading?.remove();
  } catch (e) {
    console.error(e);
    if (loading) loading.textContent = 'Sorry, Carry Crew could not start on this browser (WebGL / WebAssembly needed).';
  }
}

void boot();
