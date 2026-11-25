import { timingSafeEqual } from 'node:crypto';
import { eveChannel } from 'eve/channels/eve';

export default eveChannel({
  auth: (request) => {
    const secret = process.env.FFM_EVE_SECRET;
    if (!secret) return null;
    const got = Buffer.from(request.headers.get('authorization') ?? '');
    const expected = Buffer.from('Bearer ' + secret);
    return got.length === expected.length && timingSafeEqual(got, expected)
      ? { attributes: {}, authenticator: 'controller', principalId: 'ffm-controller', principalType: 'service' }
      : null;
  },
  fetchFile: async () => { throw new Error('Attachments are disabled'); },
});
