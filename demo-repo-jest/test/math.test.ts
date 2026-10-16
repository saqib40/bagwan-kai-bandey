import { add, multiply, safeDivide } from '../src/math';
import { makeLogger } from './helpers/mockFactory';

describe('math', () => {
  it('adds two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('multiplies two numbers', () => {
    expect(multiply(4, 5)).toBe(20);
  });

  it('returns null when dividing by zero', () => {
    expect(safeDivide(1, 0)).toBeNull();
  });

  it('reports results through an injected logger', () => {
    const logger = makeLogger();
    logger.info(String(add(1, 1)));
    expect(logger.info).toHaveBeenCalledWith('2');
  });

  it('supports mocks for callbacks', () => {
    const double = jest.fn((value: number) => value * 2);
    expect([1, 2].map(double)).toEqual([2, 4]);
    expect(double).toHaveBeenCalledTimes(2);
  });
});
