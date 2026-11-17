export type ApplicationTemplateId='wordpress'|'n8n'|'uptime-kuma'|'grafana'|'minio';
export interface ApplicationTemplate {
  id:ApplicationTemplateId;
  name:string;
  description:string;
  version:string;
  images:string[];
  setup:string;
  publisher:string;
  supportsApiDomain?:boolean;
}
export const APPLICATION_TEMPLATES:ApplicationTemplate[]=[
  {id:'wordpress',name:'WordPress',description:'WordPress with its own MariaDB database and persistent site files.',version:'2026-11-17.1',images:['wordpress:7.1.4-php8.4-apache','mariadb:11.4.13'],setup:'Open the site to finish WordPress setup. The database password is generated for this installation.',publisher:'Docker Official Images'},
  {id:'n8n',name:'n8n',description:'Workflow automation with persistent data and an installation-specific encryption key.',version:'2026-11-17.2',images:['docker.n8n.io/n8nio/n8n:2.48.4'],setup:'Open the application to create the first owner account.',publisher:'n8n'},
  {id:'uptime-kuma',name:'Uptime Kuma',description:'Availability monitoring with a persistent local database.',version:'2026-11-17.1',images:['louislam/uptime-kuma:2.5.11'],setup:'Open the application to create the administrator account.',publisher:'Uptime Kuma'},
  {id:'grafana',name:'Grafana',description:'Dashboards and data-source management with persistent configuration.',version:'2026-11-17.1',images:['grafana/grafana:13.3.1'],setup:'The administrator username is admin. View the generated password through the authorized workload configuration view.',publisher:'Grafana Labs'},
  {id:'minio',name:'MinIO',description:'S3-compatible object storage with persistent data and a separate console.',version:'2026-11-17.1',images:['ghcr.io/coollabsio/minio:RELEASE.2025-10-15T17-29-55Z'],setup:'View the generated root credentials through the authorized workload configuration view. This template uses a community-built MinIO image.',publisher:'coollabsio community image',supportsApiDomain:true},
];
