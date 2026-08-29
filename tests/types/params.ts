import { orvox } from "@orvox/core";

const app = orvox();

app.get("/orgs/:orgId/repos/:repoId", ({ params }) => {
  const orgId: string = params.orgId;
  const repoId: string = params.repoId;

  // @ts-expect-error unknown route params must not typecheck
  params.missing;

  return { orgId, repoId };
});

