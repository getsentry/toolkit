// Worker comment
export default {
  async fetch(request, env, ctx): Promise<Response> {
    return new Response('Test');
  },
};
