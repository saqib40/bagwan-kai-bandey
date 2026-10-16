/**
 * Vitest config (post-migration). Scoping `include` to `test/` is essential:
 * the engine writes historical file copies under `.bkb/checkpoints/**`, which
 * Vitest's default glob would otherwise pick up and fail on.
 */
export default {
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
};
