import RAPIER from '@dimforge/rapier2d-compat';
await RAPIER.init();
const w = new RAPIER.World({ x: 0, y: -22 }); w.timestep = 1/60; w.integrationParameters.numSolverIterations = 8;
const g = w.createRigidBody(RAPIER.RigidBodyDesc.fixed());
w.createCollider(RAPIER.ColliderDesc.cuboid(20, 1).setTranslation(0, -1), g);
const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, Number(process.argv[2] ?? 0.43)));
w.createCollider(RAPIER.ColliderDesc.cuboid(0.675, 0.425).setDensity(1.3/(1.35*0.85)).setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(1), b);
const q = new RAPIER.EventQueue(true);
for (let i = 0; i < 90; i++) { w.step(q); q.drainContactForceEvents(e => { if (i % 10 === 0 || e.maxForceMagnitude() > 60) console.log(i, 'total', e.totalForceMagnitude().toFixed(1), 'max', e.maxForceMagnitude().toFixed(1)); }); }
