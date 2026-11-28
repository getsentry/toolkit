import { someHelper } from './helpers';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return new Response(someHelper());
  },
};
