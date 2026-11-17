import{afterEach,describe,expect,it,vi}from'vitest';
import{imageDigestForReference}from'../../src/agent/registry-credentials.js';
afterEach(()=>vi.unstubAllEnvs());
describe('registry image digest selection',()=>{
  const digest=`sha256:${'a'.repeat(64)}`,other=`sha256:${'b'.repeat(64)}`,Id=`sha256:${'c'.repeat(64)}`;
  it('selects the private repository instead of an unrelated cached alias',()=>expect(imageDigestForReference('registry.example.test:5443/team/app:v1',{Id,RepoDigests:[`nginx@${digest}`,`registry.example.test:5443/team/app@${digest}`]})).toBe(`registry.example.test:5443/team/app@${digest}`));
  it.each(['nginx:alpine','library/nginx:alpine','docker.io/nginx:alpine','index.docker.io/library/nginx:alpine','registry-1.docker.io/library/nginx:alpine'])('normalizes Docker Hub identity: %s',reference=>expect(imageDigestForReference(reference,{Id,RepoDigests:[`other@${other}`,`nginx@${digest}`]})).toBe(`nginx@${digest}`));
  it('requires the exact repository and digest for a pinned reference',()=>{expect(imageDigestForReference(`registry.example.test/team/app@${digest}`,{Id,RepoDigests:[`registry.example.test/team/app@${other}`,`registry.example.test/team/app@${digest}`]})).toBe(`registry.example.test/team/app@${digest}`);vi.stubEnv('PANEL_ALLOW_LOCAL_IMAGES','1');expect(()=>imageDigestForReference(`registry.example.test/team/app@${digest}`,{Id,RepoDigests:[`registry.example.test/team/app@${other}`]})).toThrow();});
  it('fails closed on other repositories or ports even when the image IDs are identical',()=>{vi.stubEnv('PANEL_ALLOW_LOCAL_IMAGES','0');expect(()=>imageDigestForReference('registry.example.test:5443/team/app:v1',{Id,RepoDigests:[`registry.example.test:5444/team/app@${digest}`,`registry.example.test:5443/other/app@${digest}`]})).toThrow();});
  it('allows only the explicit local-image mode to fall back to an immutable image ID',()=>{vi.stubEnv('PANEL_ALLOW_LOCAL_IMAGES','0');expect(()=>imageDigestForReference('fixture:v1',{Id})).toThrow();vi.stubEnv('PANEL_ALLOW_LOCAL_IMAGES','1');expect(imageDigestForReference('fixture:v1',{Id})).toBe(Id);});
});
