// Cross-platform entry point. Site-specific settings stay in ignored .run/.
process.env.AUTO_LEARNING='1';
await import('../server.js');
