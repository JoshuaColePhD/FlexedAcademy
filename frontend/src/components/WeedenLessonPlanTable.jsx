const DAYS = [
  ['Monday', 'M'], ['Tuesday', 'T'], ['Wednesday', 'W'], ['Thursday', 'R'], ['Friday', 'F'],
]

const ROWS = [
  ['Learning Target / Essential Questions', 'learning_targets', '#e69138'],
  ['Do Now-Bell Ringer', 'do_now', '#f1c232'],
  ['Vocabulary', 'vocabulary', '#3d85c6'],
  ['I Do/We Do/You Do', 'during', '#3d85c6'],
  ['Exit Ticket', 'assessment', '#ff0000'],
  ['Assessments', 'assessment', '#a64d79'],
  ['Reteach/Small Groups', 'reteach_small_groups', '#8e7cc3'],
  ['Cross-Curriculum Connection', 'cross_curricular_connection', '#00ff00'],
]

const cellStyle = { border: '1px solid #111827', padding: '0.55rem', verticalAlign: 'top', whiteSpace: 'pre-wrap' }

/** Browser representation of Weeden's actual landscape document form. */
export function WeedenLessonPlanTable({ plan }) {
  const byDay = Object.fromEntries((plan.days || []).map((day) => [day.name, day]))
  const standards = [...new Set(DAYS.map(([name]) => byDay[name]?.standards).filter(Boolean))].join('\n\n')
  return (
    <div className="plan-table-scroll" tabIndex={0} role="region" aria-label="Weeden Elementary School weekly lesson plan">
      <table className="plan-table" style={{ borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <caption className="visually-hidden">Weeden Elementary School lesson-plan template</caption>
        <tbody>
          <tr>
            <th style={{ ...cellStyle, border: 'none', textAlign: 'center' }} colSpan="2">Learning Plans:</th>
            <th style={{ ...cellStyle, border: 'none', textAlign: 'center' }} colSpan="2">{plan.course}</th>
            <th style={{ ...cellStyle, border: 'none', textAlign: 'center' }} colSpan="2">Week Of: {plan.week_of}</th>
          </tr>
          <tr>
            <th style={cellStyle} />
            {DAYS.map(([, short]) => <th key={short} style={{ ...cellStyle, background: '#ead1dc', textAlign: 'center' }}>{short}</th>)}
          </tr>
          <tr>
            <th style={{ ...cellStyle, background: '#e06666', color: 'white', textAlign: 'center', verticalAlign: 'middle' }}>Standard / DOK</th>
            <td style={cellStyle} colSpan="5">{standards}</td>
          </tr>
          {ROWS.map(([label, field, color]) => (
            <tr key={field + label}>
              <th style={{ ...cellStyle, background: color, color: ['#e69138', '#f1c232', '#00ff00'].includes(color) ? '#111827' : 'white', textAlign: 'center', verticalAlign: 'middle' }}>{label}</th>
              {DAYS.map(([name]) => {
                const day = byDay[name]
                const value = day?.no_school ? (day.title || 'No School') : (day?.[field] || '')
                return <td key={name} style={cellStyle}>{value}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
