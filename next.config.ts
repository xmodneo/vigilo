import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  agentRules: false,
  logging: {
    incomingRequests: {
      ignore: [
        /^\/api\/auth\/callback(?:\/|$)/,
        /^\/api\/github\/installations\/(?:setup|callback)(?:\?|$)/,
      ],
    },
  },
};

export default nextConfig;
