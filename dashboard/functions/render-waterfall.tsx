import { renderToString } from "react-dom/server.edge";
import { StaticRouter } from "react-router";
import { WaterfallShell } from "../src/home/WaterfallShell";
import type { HomeFeedResponse } from "../src/types";

export async function renderWaterfall(
  data: HomeFeedResponse,
  location: string,
): Promise<string> {
  return renderToString(
    <StaticRouter location={location}>
      <WaterfallShell initialData={data} />
    </StaticRouter>,
  );
}
