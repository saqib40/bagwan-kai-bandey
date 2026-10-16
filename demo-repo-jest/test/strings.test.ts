import { capitalize, slugify } from '../src/strings';
import { makeSequentialId } from './helpers/mockFactory';

describe('strings', () => {
  it('capitalizes the first letter', () => {
    expect(capitalize('hello')).toBe('Hello');
  });

  it('slugifies arbitrary text', () => {
    expect(slugify('  Hello World!! ')).toBe('hello-world');
  });

  it('generates sequential ids', () => {
    const nextId = makeSequentialId('id');
    expect(nextId()).toBe('id-1');
    expect(nextId()).toBe('id-2');
  });

  it('tracks slug calls with a mock', () => {
    const slug = jest.fn(slugify);
    expect(slug('Hello There')).toBe('hello-there');
    expect(slug).toHaveBeenCalledTimes(1);
  });
});
