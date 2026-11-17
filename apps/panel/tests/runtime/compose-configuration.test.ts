import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { parseComposeDefinition, compileComposeDefinition } from '../../src/agent/compose-configuration.js';

describe('Compose execution boundary',()=>{
  it.each([
    'services: {web: {image: nginx, privileged: true}}',
    'services: {web: {image: nginx, network_mode: host}}',
    'services: {web: {image: nginx, pid: host}}',
    'services: {web: {image: nginx, volumes: ["/var/run/docker.sock:/socket"]}}',
    'services: {web: {image: nginx, env_file: /etc/passwd}}',
    'services: {web: {build: /etc}}',
    'include: [/etc/passwd]\nservices: {web: {image: nginx}}',
    'services: {web: {image: nginx, ports: ["80:80"]}}',
    'services: {web: {image: nginx, labels: {traefik.enable: "true"}}}',
    'services: {web: {image: nginx}}\nvolumes: {data: {external: true}}',
    'services: {web: {image: nginx}}\nnetworks: {default: {name: foreign}}',
    'services: {web: {image: nginx, environment: {TOKEN: null}}}',
    'services: {web: &ref {image: nginx}, other: *ref}',
    'services: {web: {image: nginx, image: alpine}}',
  ])('rejects unsafe or unsupported definitions before CLI evaluation: %s',yaml=>expect(()=>parseComposeDefinition(yaml)).toThrow());
  it('assigns owned resources, isolated HTTP routing and literal environment values',()=>{
    const yaml='services:\n  web:\n    image: nginx:alpine\n    environment: {VALUE: "$HOME"}\n    volumes: ["data:/content"]\n  worker:\n    image: alpine:3.21\n    command: ["sleep", "3600"]\nvolumes: {data: {}}\n';
    const id=randomUUID(),projectId=randomUUID(),configuration={source:{type:'inline' as const,yaml},domains:[{hostname:'compose.localhost',service:'web',port:80,https:false}]};
    const result=compileComposeDefinition(parseComposeDefinition(yaml),configuration,id,projectId);
    expect(result.definition.services.web.environment.VALUE).toBe('$$HOME');
    expect(result.definition.services.web.labels).toMatchObject({'panel.compose':'true','panel.owner':'self-hosted-panel','panel.workload':id,'panel.project':projectId,'traefik.enable':'true'});
    expect(result.definition.services.worker.labels['traefik.enable']).toBe('false');
    expect(result.definition.services.worker.networks).not.toContain('servus-ingress');
    expect(result.definition.volumes.data.name).toBe(`${result.prefix}_data`);
    expect(result.definition.networks['servus-ingress']).toEqual({external:true,name:'panel-ingress'});
  });
  it('preserves HTTP during issuance and scopes HTTPS, redirect and retry labels to Compose',()=>{
    const id=randomUUID(),projectId=randomUUID(),yaml='services: {web: {image: nginx}}',host='compose.example.test',base=`compose-${id.replaceAll('-','')}-0`;
    const configuration={source:{type:'inline' as const,yaml},domains:[{hostname:host,service:'web',port:8080,https:true}]};
    const labels=compileComposeDefinition(parseComposeDefinition(yaml),configuration,id,projectId).definition.services.web.labels;
    expect(labels[`traefik.http.routers.${base}.entrypoints`]).toBe('web');
    expect(labels[`traefik.http.routers.${base}-https.tls.certresolver`]).toBe('servus');
    expect(labels[`traefik.http.routers.${base}-https.service`]).toBe(base);
    expect(labels[`traefik.http.services.${base}.loadbalancer.server.port`]).toBe('8080');
    expect(labels[`traefik.http.routers.${base}.middlewares`]).toBeUndefined();
    const redirect={...configuration,domains:configuration.domains.map(domain=>({...domain,redirectHttps:true}))};
    const next=compileComposeDefinition(parseComposeDefinition(yaml),redirect,id,projectId,{[host]:{requestedAt:'2026-11-17T12:00:00Z',explicitDomain:true}}).definition.services.web.labels;
    expect(next[`traefik.http.routers.${base}.middlewares`]).toBe(`${base}-redirect`);
    expect(next[`traefik.http.routers.${base}-https.tls.domains[0].main`]).toBe(host);
    expect(next[`traefik.http.middlewares.${base}-redirect.redirectscheme.scheme`]).toBe('https');
    expect(next['panel.compose-acme-retry-0']).toBe('2026-11-17T12:00:00Z');
  });

});
