import ProjectWorkspace from '@/components/ProjectWorkspace';
import copy from '@/messages/en/projects.json';

export const metadata = { title: 'Projects · Open Generative AI' };

export default async function ProjectsPage({ params }) {
  return <ProjectWorkspace copy={copy} root="" projectId={(await params).projectId} />;
}
