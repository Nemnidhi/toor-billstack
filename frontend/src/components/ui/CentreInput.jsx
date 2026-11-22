import { useEffect, useId, useState } from "react";
import api from "../../api/axios";

// Property / centre picker: type a new name or pick one already in use.
// Centres split the Profit & Loss by location (Accounting > Profit & Loss > Profit by centre).
let centresPromise = null;

export const loadCentres = () => {
  if (!centresPromise) {
    centresPromise = api
      .get("/accounting/centres")
      .then((response) => response.data?.data || [])
      .catch(() => {
        centresPromise = null;
        return [];
      });
  }
  return centresPromise;
};

// Call after saving a record with a new centre so the next picker lists it.
export const forgetCentres = () => {
  centresPromise = null;
};

const CentreInput = ({ value, onChange, className = "field", placeholder = "e.g. Vijay Nagar centre", name = "centre", disabled = false }) => {
  const listId = useId();
  const [names, setNames] = useState([]);

  useEffect(() => {
    let live = true;
    loadCentres().then((list) => {
      if (live) setNames(list);
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <>
      <input
        name={name}
        list={listId}
        value={value || ""}
        onChange={(event) => onChange(event.target.value)}
        maxLength={80}
        autoComplete="off"
        disabled={disabled}
        className={className}
        placeholder={placeholder}
      />
      <datalist id={listId}>
        {names.map((item) => (
          <option key={item} value={item} />
        ))}
      </datalist>
    </>
  );
};

export default CentreInput;
