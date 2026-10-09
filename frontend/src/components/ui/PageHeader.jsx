// Shared page heading: compact title row with optional kicker, description and actions.
const PageHeader = ({ kicker, title, description, actions, children }) => (
  <header className="page-header">
    <div className="min-w-0">
      {kicker ? <p className="page-kicker">{kicker}</p> : null}
      <h1 className="page-title">{title}</h1>
      {description ? <p className="page-subtitle">{description}</p> : null}
      {children}
    </div>
    {actions ? <div className="page-actions">{actions}</div> : null}
  </header>
);

export default PageHeader;
