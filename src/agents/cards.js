const protocolVersion = '0.3.0';
const agentVersion = '1.0.0';
const textModes = ['text/plain'];

function createCard({ name, description, baseUrl, skills }) {
  const endpoint = `${baseUrl}/a2a/jsonrpc`;

  return {
    name,
    description,
    protocolVersion,
    version: agentVersion,
    url: endpoint,
    preferredTransport: 'JSONRPC',
    additionalInterfaces: [{ url: endpoint, transport: 'JSONRPC' }],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: textModes,
    defaultOutputModes: textModes,
    skills,
  };
}

export function createRouterCard(baseUrl) {
  return createCard({
    name: 'Router Agent',
    description:
      'Routes math and writing requests to independent specialists over A2A HTTP.',
    baseUrl,
    skills: [
      {
        id: 'route-specialist-request',
        name: 'Route Specialist Request',
        description:
          'Delegates math, editing, rewriting, and writing work to the correct remote agent.',
        tags: ['routing', 'math', 'writing', 'a2a'],
        examples: [
          'Calculate 18 percent of 245.',
          'Rewrite this paragraph in a friendlier tone.',
          'Calculate the result and explain it in a polished email.',
        ],
      },
    ],
  });
}

export function createMathCard(baseUrl) {
  return createCard({
    name: 'Math Specialist Agent',
    description: 'Solves mathematical questions accurately and explains essential steps.',
    baseUrl,
    skills: [
      {
        id: 'solve-math',
        name: 'Solve Math',
        description: 'Handles arithmetic, algebra, geometry, probability, and related math.',
        tags: ['math', 'calculation', 'reasoning'],
        examples: ['Solve 3x + 7 = 22.', 'What is the area of a circle with radius 4?'],
      },
    ],
  });
}

export function createWritingCard(baseUrl) {
  return createCard({
    name: 'Writing Specialist Agent',
    description: 'Writes, edits, and rewrites text for the requested audience and tone.',
    baseUrl,
    skills: [
      {
        id: 'write-and-edit',
        name: 'Write and Edit',
        description: 'Creates, edits, rewrites, and polishes text.',
        tags: ['writing', 'editing', 'rewriting'],
        examples: [
          'Rewrite this note to sound more professional.',
          'Draft a concise product announcement.',
        ],
      },
    ],
  });
}
