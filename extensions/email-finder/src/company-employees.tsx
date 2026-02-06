import { Action, ActionPanel, Form, Icon, LaunchProps, List, showToast, Toast, useNavigation } from "@raycast/api";
import { useState, useEffect, useRef } from "react";
import { EnrichedData, ResultsView } from "./email-finder";
import { AuthGate } from "./auth";
import { searchPerson, enrichPerson, SearchPersonResponse, EnrichPersonResponse } from "./backend";
import { fetchCredits, formatCredits } from "./credits";
import { CompanySearch } from "./company-search";
import { addCompanySearchHistoryEntry, addSearchHistoryEntry, CachedEmployee } from "./history-storage";

// * Types
interface Arguments {
  domain?: string;
}

// * Employee with department info for grouping
interface Employee {
  id: string;
  firstName: string;
  lastName: string;
  fullName: string;
  jobTitle: string;
  departments: string[];
  linkedinUrl?: string;
  location?: string;
  seniority?: string;
}

// * Department group
interface DepartmentGroup {
  name: string;
  employees: Employee[];
}

// * Map search response to employees
function mapSearchResponseToEmployees(response: SearchPersonResponse): Employee[] {
  if (!response.results || response.results.length === 0) {
    return [];
  }

  return response.results.map((item) => {
    const person = item.person;
    // * Extract current job info
    const currentJob = person.job_history?.find((job) => job.current);
    const departments = currentJob?.departments ?? [];

    return {
      id: person.person_id,
      firstName: person.first_name,
      lastName: person.last_name,
      fullName: person.full_name,
      jobTitle: person.current_job_title || currentJob?.title || "",
      departments: departments.length > 0 ? departments : ["Other"],
      linkedinUrl: person.linkedin_url,
      location: person.location ? `${person.location.city}, ${person.location.country}` : undefined,
      seniority: currentJob?.seniority,
    };
  });
}

// * Map enrich response to EnrichedData
function mapEnrichResponseToData(response: EnrichPersonResponse, domain: string): EnrichedData | null {
  if (!response.person?.email?.email) return null;

  return {
    person: {
      first_name: response.person.first_name,
      last_name: response.person.last_name,
      full_name: response.person.full_name,
      headline: response.person.headline || null,
      linkedin_url: response.person.linkedin_url || null,
      current_job_title: response.person.current_job_title || undefined,
      job_history: (response.person.job_history || []) as EnrichedData["person"]["job_history"],
      mobile: response.person.mobile
        ? {
            status: response.person.mobile.status,
            mobile_international: response.person.mobile.mobile_international || null,
            mobile_country: response.person.mobile.mobile_country,
          }
        : null,
      email: {
        status: response.person.email.status,
        email: response.person.email.email,
        email_mx_provider: response.person.email.email_mx_provider,
      },
      location: response.person.location
        ? {
            country: response.person.location.country,
            city: response.person.location.city,
            state: response.person.location.state,
            country_code: response.person.location.country_code,
          }
        : null,
    },
    company: {
      name: response.company?.name || domain,
      website: response.company?.website || `https://${domain}`,
      domain: response.company?.domain || domain,
      type: response.company?.type || null,
      industry: response.company?.industry || "",
      description_ai: response.company?.description_ai || null,
      employee_range: response.company?.employee_range || "",
      employee_count: response.company?.employee_count,
      founded: response.company?.founded || 0,
      linkedin_url: response.company?.linkedin_url || null,
      twitter_url: response.company?.twitter_url || null,
      logo_url: response.company?.logo_url || null,
      location: response.company?.location
        ? {
            country: response.company.location.country,
            city: response.company.location.city,
            raw_address: response.company.location.raw_address,
          }
        : null,
      revenue_range_printed: response.company?.revenue_range_printed || null,
      funding: response.company?.funding
        ? {
            total_funding_printed: response.company.funding.total_funding_printed,
            latest_funding_stage: response.company.funding.latest_funding_stage,
            latest_funding_date: response.company.funding.latest_funding_date,
            funding_events: response.company.funding.funding_events,
          }
        : null,
      keywords: response.company?.keywords,
    },
  };
}

// * Group employees by department
function groupByDepartment(employees: Employee[]): DepartmentGroup[] {
  const departmentMap = new Map<string, Employee[]>();

  for (const employee of employees) {
    // ? Put employee in each department they belong to
    for (const dept of employee.departments) {
      const existing = departmentMap.get(dept) || [];
      existing.push(employee);
      departmentMap.set(dept, existing);
    }
  }

  // * Sort departments alphabetically, but put "Other" at the end
  const sortedDepts = Array.from(departmentMap.keys()).sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });

  return sortedDepts.map((name) => ({
    name,
    employees: departmentMap.get(name) || [],
  }));
}

export default function Command(props: LaunchProps<{ arguments: Arguments }>) {
  return <AuthGate>{(signOut) => <CompanyEmployeesEntry signOut={signOut} arguments={props.arguments} />}</AuthGate>;
}

// * Entry point - decides which view to show based on arguments
function CompanyEmployeesEntry({ signOut, arguments: args }: { signOut: () => Promise<void>; arguments: Arguments }) {
  const { domain: argDomain } = args;

  // * If domain is provided, go directly to employee list
  if (argDomain) {
    return <EmployeeListView signOut={signOut} initialDomain={argDomain} autoSearch={true} />;
  }

  // * Otherwise, show company search which uses Action.Push to navigate to list
  return <EmployeesCompanySearch signOut={signOut} />;
}

// * Company Search for Employees - uses Action.Push for navigation
function EmployeesCompanySearch({ signOut }: { signOut: () => Promise<void> }) {
  // * Use callback-based CompanySearch but handle the callback to push the next view
  const { push } = useNavigation();

  function handleCompanySelect(company: { domain: string; name: string; logo_url?: string; confidence_score: number }) {
    push(
      <EmployeeListView
        signOut={signOut}
        initialDomain={company.domain}
        companyInfo={{ name: company.name, logoUrl: company.logo_url, confidenceScore: company.confidence_score }}
        autoSearch={true}
      />,
    );
  }

  function handleEnterManually() {
    push(<DomainEntryForm signOut={signOut} />);
  }

  return (
    <CompanySearch onSelectCompany={handleCompanySelect} onEnterManually={handleEnterManually} signOut={signOut} />
  );
}

// * Domain Entry Form - for manual domain entry
function DomainEntryForm({ signOut }: { signOut: () => Promise<void> }) {
  const { push } = useNavigation();
  const [credits, setCredits] = useState<number | null>(null);

  useEffect(() => {
    fetchCredits()
      .then(setCredits)
      .catch(() => setCredits(null));
  }, []);

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Search Company"
            onSubmit={(values) => {
              push(<EmployeeListView signOut={signOut} initialDomain={values.domain} autoSearch={true} />);
            }}
          />
          <Action title="Sign out" icon={Icon.Logout} onAction={signOut} />
        </ActionPanel>
      }
    >
      <Form.Description title="Credits" text={credits !== null ? formatCredits(credits) : "Loading..."} />
      <Form.Separator />
      <Form.TextField id="domain" title="Company Domain" placeholder="rebtel.com" autoFocus />
    </Form>
  );
}

// * Employee List View - shows employees grouped by department
function EmployeeListView({
  signOut,
  initialDomain,
  companyInfo,
  autoSearch = false,
}: {
  signOut: () => Promise<void>;
  initialDomain: string;
  companyInfo?: { name: string; logoUrl?: string; confidenceScore: number };
  autoSearch?: boolean;
}) {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [credits, setCredits] = useState<number | null>(null);
  const [filterText, setFilterText] = useState("");

  // * Fetch credits on mount
  useEffect(() => {
    fetchCredits()
      .then(setCredits)
      .catch(() => setCredits(null));
  }, []);

  // * Auto-search on mount if requested
  useEffect(() => {
    if (autoSearch && !hasSearched && !isLoading) {
      searchCompany(initialDomain, companyInfo);
    }
  }, [autoSearch, hasSearched, isLoading]);

  async function searchCompany(
    searchDomain: string,
    company?: { name: string; logoUrl?: string; confidenceScore: number },
  ) {
    if (!searchDomain.trim()) {
      showToast({ style: Toast.Style.Failure, title: "Error", message: "Please enter a domain" });
      return;
    }

    setIsLoading(true);
    setEmployees([]);
    setHasSearched(true);
    setCurrentPage(0);
    setTotalPages(0);

    showToast({ style: Toast.Style.Animated, title: "Searching...", message: `Finding employees at ${searchDomain}` });

    try {
      const response = await searchPerson(searchDomain, 1);

      if (typeof response.balance === "number") {
        setCredits(response.balance);
      }

      const mappedEmployees = mapSearchResponseToEmployees(response);
      setEmployees(mappedEmployees);
      setCurrentPage(response.pagination?.page ?? 1);
      setTotalPages(response.pagination?.total_pages ?? 0);

      // * Save to history with employee data
      if (mappedEmployees.length > 0) {
        const cachedEmployees: CachedEmployee[] = mappedEmployees.map((e) => ({
          id: e.id,
          firstName: e.firstName,
          lastName: e.lastName,
          fullName: e.fullName,
          jobTitle: e.jobTitle,
          departments: e.departments,
          linkedinUrl: e.linkedinUrl,
          location: e.location,
          seniority: e.seniority,
        }));

        await addCompanySearchHistoryEntry({
          companyName: company?.name || searchDomain,
          domain: searchDomain,
          confidenceScore: company?.confidenceScore ?? 100,
          logoUrl: company?.logoUrl,
          employees: cachedEmployees,
          totalPages: response.pagination?.total_pages ?? 1,
          currentPage: response.pagination?.page ?? 1,
        });
      }

      if (mappedEmployees.length === 0) {
        showToast({ style: Toast.Style.Failure, title: "No Results", message: "No employees found for this domain" });
      } else {
        showToast({
          style: Toast.Style.Success,
          title: "Found",
          message: `${mappedEmployees.length} employees (page 1/${response.pagination?.total_pages ?? 1})`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      showToast({ style: Toast.Style.Failure, title: "Failed", message });
      fetchCredits()
        .then(setCredits)
        .catch(() => {});
    } finally {
      setIsLoading(false);
    }
  }

  async function loadMoreEmployees() {
    if (currentPage >= totalPages || isLoading) return;

    setIsLoading(true);
    showToast({ style: Toast.Style.Animated, title: "Loading more...", message: `Page ${currentPage + 1}` });

    try {
      const response = await searchPerson(initialDomain, currentPage + 1);

      if (typeof response.balance === "number") {
        setCredits(response.balance);
      }

      const newMappedEmployees = mapSearchResponseToEmployees(response);

      // * Dedupe by employee id
      const existingIds = new Set(employees.map((e) => e.id));
      const newEmployees = newMappedEmployees.filter((e) => !existingIds.has(e.id));

      setEmployees([...employees, ...newEmployees]);
      setCurrentPage(response.pagination?.page ?? currentPage + 1);

      showToast({
        style: Toast.Style.Success,
        title: "Loaded",
        message: `${newEmployees.length} more employees`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      showToast({ style: Toast.Style.Failure, title: "Failed", message });
      fetchCredits()
        .then(setCredits)
        .catch(() => {});
    } finally {
      setIsLoading(false);
    }
  }

  // * Group employees by department
  const departmentGroups = groupByDepartment(employees);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Filter employees..."
      navigationTitle={initialDomain ? `Employees at ${initialDomain}` : "Company Employees"}
      searchText={filterText}
      onSearchTextChange={setFilterText}
    >
      {!hasSearched || employees.length === 0 ? (
        <List.EmptyView
          title={hasSearched ? "No Employees Found" : "Search for a Company"}
          description={hasSearched ? "No employees found for this domain" : "Enter a company domain to find employees"}
          icon={Icon.Person}
        />
      ) : (
        <>
          {/* Credits display */}
          <List.Section title="Account">
            <List.Item
              title="Credits Remaining"
              subtitle={credits !== null ? formatCredits(credits) : "Loading..."}
              icon={Icon.Coins}
              actions={
                <ActionPanel>
                  <Action title="Sign out" icon={Icon.Logout} onAction={signOut} />
                </ActionPanel>
              }
            />
          </List.Section>

          {departmentGroups.map((group) => (
            <List.Section key={group.name} title={group.name} subtitle={`${group.employees.length} employees`}>
              {group.employees.map((employee) => (
                <List.Item
                  key={`${group.name}-${employee.id}`}
                  title={employee.fullName}
                  subtitle={employee.jobTitle}
                  icon={Icon.Person}
                  accessories={[
                    employee.seniority ? { tag: employee.seniority } : {},
                    employee.location ? { text: employee.location, icon: Icon.Pin } : {},
                  ].filter((a) => Object.keys(a).length > 0)}
                  actions={
                    <ActionPanel>
                      <Action.Push
                        title="Reveal Email"
                        icon={Icon.Envelope}
                        target={
                          <EnrichedEmployeeView
                            signOut={signOut}
                            employee={employee}
                            domain={initialDomain}
                            credits={credits}
                          />
                        }
                      />
                      {employee.linkedinUrl && (
                        <>
                          <Action.OpenInBrowser
                            title="Open LinkedIn"
                            url={employee.linkedinUrl}
                            shortcut={{ modifiers: ["cmd"], key: "o" }}
                          />
                          <Action.CopyToClipboard
                            title="Copy LinkedIn URL"
                            content={employee.linkedinUrl}
                            shortcut={{ modifiers: ["cmd"], key: "l" }}
                          />
                        </>
                      )}
                      <Action title="Sign out" icon={Icon.Logout} onAction={signOut} />
                    </ActionPanel>
                  }
                />
              ))}
            </List.Section>
          ))}

          {/* Load more section */}
          {currentPage < totalPages && (
            <List.Section title="More Results">
              <List.Item
                title={`Load More (Page ${currentPage + 1} of ${totalPages})`}
                icon={Icon.Download}
                actions={
                  <ActionPanel>
                    <Action title="Load More" icon={Icon.Download} onAction={loadMoreEmployees} />
                  </ActionPanel>
                }
              />
            </List.Section>
          )}
        </>
      )}
    </List>
  );
}

// * Enriched Employee View - fetches and displays enriched person data
function EnrichedEmployeeView({
  signOut,
  employee,
  domain,
  credits: initialCredits,
}: {
  signOut: () => Promise<void>;
  employee: Employee;
  domain: string;
  credits: number | null;
}) {
  const [enrichedData, setEnrichedData] = useState<EnrichedData | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [credits, setCredits] = useState<number | null>(initialCredits);
  const hasStartedRef = useRef(false);

  // * Fetch enriched data on mount
  useEffect(() => {
    // Prevent duplicate requests from React Strict Mode double-mounting
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;

    let cancelled = false;

    async function fetchEnrichedData() {
      showToast({
        style: Toast.Style.Animated,
        title: "Revealing...",
        message: `Getting email for ${employee.fullName}`,
      });

      try {
        const response = await enrichPerson(employee.firstName, employee.lastName, domain);

        if (cancelled) return;

        if (typeof response.balance === "number") {
          setCredits(response.balance);
        }

        const mappedData = mapEnrichResponseToData(response, domain);
        if (!mappedData) {
          throw new Error("No email found for this person");
        }

        setEnrichedData(mappedData);

        // * Save to email search history
        await addSearchHistoryEntry({
          firstName: employee.firstName,
          lastName: employee.lastName,
          domain,
          status: "success",
          email: mappedData.person.email.email,
          enrichedData: mappedData,
        });

        showToast({ style: Toast.Style.Success, title: "Found", message: mappedData.person.email.email });
      } catch (err) {
        if (cancelled) return;

        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);

        // * Save failed search to history too
        await addSearchHistoryEntry({
          firstName: employee.firstName,
          lastName: employee.lastName,
          domain,
          status: "error",
          error: message,
        });

        showToast({ style: Toast.Style.Failure, title: "Failed", message });
        fetchCredits()
          .then(setCredits)
          .catch(() => {});
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    fetchEnrichedData();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <ResultsView
      data={enrichedData}
      isLoading={isLoading}
      error={error}
      searchParams={{ firstName: employee.firstName, lastName: employee.lastName, domain }}
      credits={credits}
      signOut={signOut}
    />
  );
}
