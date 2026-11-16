import { principal, create, API_A } from "../tests/client.ts";
const alice = await principal("demo", "Alice");
const bob = await principal("demo", "Bob");
const viewer = await principal("demo", "Reviewer", "viewer");
await create(
  alice.token,
  "Incident response handoff",
  "# Incident response handoff\n\n## Current understanding\nWrite the facts, open questions, and the next action here.\n\n## Investigation\n- Reproduce the symptom\n- Compare logs and recent changes\n- Record the mitigation\n\n## Handoff\nKeep this note current as the investigation progresses.\n",
);
console.log(
  "ALICE_TOKEN=" +
    alice.token +
    "\nBOB_TOKEN=" +
    bob.token +
    "\nVIEWER_TOKEN=" +
    viewer.token +
    "\nOpen http://localhost:3000 in two browser profiles. API: " +
    API_A,
);
