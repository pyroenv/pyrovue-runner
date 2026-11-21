import { describe, expect, it } from "vitest";
import { detect } from "../../src/pipeline/detect";
import { detectorTrust } from "../../src/pipeline/ranking";
import { selectKeyFiles } from "../../src/pipeline/snapshot";

const snap = (contents: Record<string, string>, extra: string[] = []) => ({ files: [...Object.keys(contents), ...extra], contents });

describe("detect: .NET", () => {
  it("runs the one ASP.NET Core project of a solution", () => {
    // jasontaylordev/CleanArchitecture: src/Web is the site; src/AppHost is the Aspire orchestrator, which needs Docker.
    const plan = detect(
      snap({}, [
        "CleanArchitecture.slnx",
        "src/Web/Web.csproj",
        "src/Web/Program.cs",
        "src/Web/appsettings.json",
        "src/Web/Properties/launchSettings.json",
        "src/AppHost/AppHost.csproj",
        "src/AppHost/Program.cs",
        "src/AppHost/appsettings.json",
        "src/Application/Application.csproj",
        "src/Application/TodoItems/CreateTodoItem.cs",
        "tests/Web.AcceptanceTests/Web.AcceptanceTests.csproj",
        "tests/Web.AcceptanceTests/appsettings.json",
        "tests/Web.AcceptanceTests/Program.cs",
      ]),
    );
    expect(plan).toMatchObject({
      stack: [".NET", "ASP.NET Core"],
      kind: "web",
      summary: "ASP.NET Core app in src/Web/.",
      start: "dotnet run --project src/Web --no-launch-profile --urls http://0.0.0.0:5000",
      port: 5000,
      cwd: "/workspace",
      confidence: "medium",
      strategy: "framework",
      signature: "dotnet:aspnet:nuget",
    });
    expect(plan.setup).toEqual(["mise use -g dotnet@10", "dotnet restore src/Web"]);
    // Without a launch profile the app would start in Production; an SDK newer than the target still runs it.
    expect(plan.env).toMatchObject({ ASPNETCORE_ENVIRONMENT: "Development", DOTNET_ROLL_FORWARD: "Major" });
    expect(detectorTrust(plan)).toBeLessThan(0.75);
  });

  it("runs an ASP.NET Core project that is the whole repository", () => {
    const plan = detect(snap({}, ["TodoApi.csproj", "Program.cs", "appsettings.json", "appsettings.Development.json", "Controllers/TodoController.cs"]));
    expect(plan).toMatchObject({ kind: "web", summary: "ASP.NET Core app.", start: "dotnet run --no-launch-profile --urls http://0.0.0.0:5000", port: 5000 });
    expect(plan.setup).toEqual(["mise use -g dotnet@10", "dotnet restore"]);
  });

  it("restores a library without proposing a start command", () => {
    // DapperLib/Dapper: a solution of class libraries and their tests.
    const plan = detect(snap({}, ["Dapper.sln", "Dapper/Dapper.csproj", "Dapper/SqlMapper.cs", "tests/Dapper.Tests/Dapper.Tests.csproj", "tests/Dapper.Tests/QueryTests.cs"]));
    expect(plan).toMatchObject({ stack: [".NET"], kind: "cli", start: null, port: null, summary: ".NET solution.", confidence: "low", signature: "dotnet:none:nuget" });
    expect(plan.setup).toEqual(["mise use -g dotnet@10", "dotnet restore Dapper.sln"]);
  });

  it("installs the exact SDK that global.json pins", () => {
    // The default roll-forward only accepts the same feature band, so "the latest 9" could be refused.
    const plan = detect(snap({ "global.json": '{\n  // comments are allowed here\n  "sdk": { "version": "9.0.203", "rollForward": "latestFeature" }\n}\n' }, ["Lib.sln", "src/Lib/Lib.csproj", "src/Lib/Class1.cs"]));
    expect(plan.setup[0]).toBe("mise use -g dotnet@9.0.203");
    expect(selectKeyFiles(["global.json", "src/global.json"])).toEqual(["global.json"]);
  });

  it("recognises a Windows desktop app and proposes nothing to run", () => {
    // ShareX/ShareX, NickeManarin/ScreenToGif: WPF and WinForms need Windows; nothing listens on a port.
    const wpf = detect(snap({}, ["ScreenToGif.sln", "ScreenToGif/ScreenToGif.csproj", "ScreenToGif/App.xaml", "ScreenToGif/App.xaml.cs", "ScreenToGif/Windows/Recorder.xaml"]));
    expect(wpf).toMatchObject({ stack: [".NET", "Desktop app"], kind: "unknown", setup: [], start: null, port: null, summary: ".NET desktop app.", signature: "dotnet:desktop:nuget", confidence: "low" });
    expect(wpf.notes?.[0]).toMatch(/desktop app/);
    const winforms = detect(snap({}, ["Optimizer.sln", "Optimizer/Optimizer.csproj", "Optimizer/Program.cs", "Optimizer/Forms/MainForm.cs", "Optimizer/Forms/MainForm.Designer.cs", "Optimizer/Forms/MainForm.resx"]));
    expect(winforms.signature).toBe("dotnet:desktop:nuget");
  });

  it("only restores a solution with several ASP.NET Core projects, and says which", () => {
    // bitwarden/server: Api, Identity and Admin are separate servers.
    const web = (dir: string) => [`${dir}/${dir.split("/").pop()}.csproj`, `${dir}/Program.cs`, `${dir}/appsettings.json`];
    const plan = detect(snap({}, ["bitwarden-server.sln", ...web("src/Api"), ...web("src/Identity"), ...web("src/Admin"), "src/Core/Core.csproj", "src/Core/Entities/User.cs"]));
    expect(plan).toMatchObject({ kind: "cli", start: null, port: null, signature: "dotnet:aspnet-multi:nuget", confidence: "low" });
    expect(plan.summary).toBe(".NET solution with 3 ASP.NET Core projects (src/Admin, src/Api and src/Identity).");
    expect(plan.setup).toEqual(["mise use -g dotnet@10", "dotnet restore bitwarden-server.sln"]);
    expect(plan.notes?.[0]).toBe(
      "This solution has 3 ASP.NET Core projects, so Pyrovue does not pick one to start. Packages are restored; start one with `dotnet run --project src/Admin --no-launch-profile --urls http://0.0.0.0:5000` in the terminal.",
    );
  });

  it("doesn't take a project buried in a library's tree for the app", () => {
    // dotnet/maui: the only folder with appsettings.json and Program.cs is a project template five levels down.
    const plan = detect(
      snap({}, ["Microsoft.Maui.sln", "src/Core/src/Core.csproj", "src/Core/src/Handlers/ViewHandler.cs", "src/Templates/src/templates/maui-blazor-solution/MauiApp.1.Web/MauiApp.1.Web.csproj", "src/Templates/src/templates/maui-blazor-solution/MauiApp.1.Web/Program.cs", "src/Templates/src/templates/maui-blazor-solution/MauiApp.1.Web/appsettings.json"]),
    );
    expect(plan).toMatchObject({ kind: "cli", start: null, signature: "dotnet:none:nuget" });
  });

  it("doesn't start a test host", () => {
    const plan = detect(snap({}, ["Kernel.sln", "src/Kernel/Kernel.csproj", "src/Kernel/Kernel.cs", "src/Kernel.IntegrationTests/Kernel.IntegrationTests.csproj", "src/Kernel.IntegrationTests/Program.cs", "src/Kernel.IntegrationTests/appsettings.json"]));
    expect(plan).toMatchObject({ kind: "cli", start: null, signature: "dotnet:none:nuget" });
  });

  it("restores a library that ships a few XAML views instead of calling it a desktop app", () => {
    // PowerShell/PowerShell: a help window's XAML inside one library; no App.xaml, so no application.
    const plan = detect(snap({}, ["PowerShell.sln", "src/System.Management.Automation/System.Management.Automation.csproj", "src/System.Management.Automation/engine/Runspace.cs", "src/Microsoft.Management.UI.Internal/HelpWindow/HelpWindow.xaml"]));
    expect(plan).toMatchObject({ kind: "cli", signature: "dotnet:none:nuget" });
    expect(plan.setup).toEqual(["mise use -g dotnet@10", "dotnet restore PowerShell.sln"]);
  });

  it("leaves a Visual C++ solution alone", () => {
    // Chuyu-Team/Dism-Multi-language: a .sln of .vcxproj files is not .NET.
    const plan = detect(snap({}, ["Languages.sln", "Files.vcxproj", "Files.vcxproj.filters", "README.md"]));
    expect(plan.signature).toBe("unknown");
    expect(plan.setup).toEqual([]);
  });

  it("doesn't mistake a folder that merely ends in 'test' for a test project", () => {
    const plan = detect(snap({}, ["Trading.sln", "Backtest/Backtest.csproj", "Backtest/Program.cs", "Backtest/appsettings.json", "Core/Core.csproj"]));
    expect(plan).toMatchObject({ kind: "web", start: "dotnet run --project Backtest --no-launch-profile --urls http://0.0.0.0:5000" });
  });

  it("quotes a solution or a project folder whose name has a space", () => {
    // HearthSim/Hearthstone-Deck-Tracker: "Hearthstone Deck Tracker.sln".
    const lib = detect(snap({}, ["Hearthstone Deck Tracker.sln", "HearthDb/HearthDb.csproj", "HearthDb/Card.cs"]));
    expect(lib.setup[1]).toBe("dotnet restore 'Hearthstone Deck Tracker.sln'");
    const web = detect(snap({}, ["App.sln", "My App/My App.csproj", "My App/Program.cs", "My App/appsettings.json"]));
    expect(web.start).toBe("dotnet run --project 'My App' --no-launch-profile --urls http://0.0.0.0:5000");
    expect(web.setup[1]).toBe("dotnet restore 'My App'");
  });

  it("reads the project file when it has it: a worker service is not a web app", () => {
    const files = ["Worker.sln", "src/Worker/Program.cs", "src/Worker/appsettings.json", "src/Worker/Worker.cs"];
    const worker = detect(snap({ "src/Worker/Worker.csproj": '<Project Sdk="Microsoft.NET.Sdk.Worker">\n  <PropertyGroup>\n    <TargetFramework>net9.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n' }, files));
    expect(worker).toMatchObject({ kind: "cli", start: null, signature: "dotnet:none:nuget" });
    const web = detect(snap({ "src/Worker/Worker.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web">\n</Project>\n' }, files));
    expect(web).toMatchObject({ kind: "web", signature: "dotnet:aspnet:nuget" });
    // Project files near the root are read into the snapshot for this.
    expect(selectKeyFiles(["Api.csproj", "src/Web/Web.csproj", "src/a/b/Deep.csproj", "tests/Web.Tests/Web.Tests.csproj"])).toEqual(["Api.csproj", "src/Web/Web.csproj"]);
  });

  it("doesn't take an Entity Framework migration's designer file for a WinForms form", () => {
    const plan = detect(snap({}, ["Crm.sln", "src/Data/Data.csproj", "src/Data/Migrations/20240312_AddContactForm.cs", "src/Data/Migrations/20240312_AddContactForm.Designer.cs"]));
    expect(plan.signature).toBe("dotnet:none:nuget");
  });

  it("finds a solution one folder down", () => {
    // 2dust/v2rayN, Jackett/Jackett: the solution sits in the source folder.
    const plan = detect(snap({}, ["README.md", "src/Jackett.sln", "src/Jackett.Common/Jackett.Common.csproj", "src/Jackett.Common/Indexers/BaseIndexer.cs"]));
    expect(plan).toMatchObject({ signature: "dotnet:none:nuget", start: null });
    expect(plan.setup).toEqual(["mise use -g dotnet@10", "dotnet restore src/Jackett.sln"]);
  });
});

describe("detect: .NET next to other languages", () => {
  it("runs an ASP.NET Core server with its frontend folder in front, in Development", () => {
    const plan = detect(snap({ "frontend/package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }) }, ["Shop.sln", "src/Api/Api.csproj", "src/Api/Program.cs", "src/Api/appsettings.json", "src/Api/Controllers/OrdersController.cs", "frontend/src/main.ts"]));
    expect(plan).toMatchObject({ strategy: "framework:both", signature: "dotnet:aspnet:nuget", cwd: "/workspace/frontend", port: 5173 });
    expect(plan.summary).toBe("Vite app using npm in frontend/ with an ASP.NET Core backend in the repo root.");
    expect(plan.services?.[0]).toMatchObject({ command: "dotnet run --project src/Api --no-launch-profile --urls http://0.0.0.0:5000", port: 5000 });
    // What the server needs to start is still set when it runs behind the dev server.
    expect(plan.env).toMatchObject({ ASPNETCORE_ENVIRONMENT: "Development", DOTNET_ROLL_FORWARD: "Major", PORT: "5173" });
  });

  it("keeps a .NET server whose web UI starts from the root package.json as Node.js", () => {
    // Sonarr/Sonarr: `yarn start` runs the frontend's dev build from the root.
    const plan = detect(snap({ "package.json": JSON.stringify({ scripts: { start: "vite" }, devDependencies: { vite: "6" } }) }, ["src/Sonarr.sln", "src/NzbDrone.Core/Sonarr.Core.csproj", "src/NzbDrone.Core/Tv/Series.cs", "frontend/src/index.ts"]));
    expect(plan.signature).toBe("node:vite:npm");
  });

  it("reads a .NET repository with a tooling package.json at the root as .NET", () => {
    // dotnet/aspnetcore: package.json only declares the workspaces of the JavaScript client libraries.
    const plan = detect(
      snap({ "package.json": JSON.stringify({ private: true, workspaces: ["src/SignalR/clients/ts/*"], scripts: { lint: "eslint ." } }) }, ["AspNetCore.slnx", "src/Mvc/Mvc.Core/src/Microsoft.AspNetCore.Mvc.Core.csproj", "src/Mvc/Mvc.Core/src/ControllerBase.cs", "src/Http/Http/src/HttpContext.cs", "src/SignalR/clients/ts/signalr/src/index.ts"]),
    );
    expect(plan.signature).toBe("dotnet:none:nuget");
    expect(plan.setup.join("\n")).not.toMatch(/\bnpm\b/);
  });
});
