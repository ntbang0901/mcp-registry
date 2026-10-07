/** An expected, user-facing failure. The CLI prints the message without a stack trace. */
export class LoadoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadoutError';
  }
}
